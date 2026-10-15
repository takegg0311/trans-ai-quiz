"""実 TCP/WebSocket で20参加者が競合するローカル負荷検証。外部APIは呼ばない。"""
from __future__ import annotations

import asyncio
import json
import socket
import threading
import time

import httpx
import uvicorn
from websockets.asyncio.client import connect

from app.cloud.app import create_app
from app.cloud.service import Settings
from .test_cloud import MemoryObjects, MemoryStates, archive


def test_twenty_players_over_real_websockets():
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    settings = Settings("password", "s" * 32, origin, secure_cookie=False)
    app = create_app(settings, MemoryStates(), MemoryObjects())
    server = uvicorn.Server(uvicorn.Config(app, log_level="error"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(.01)
        assert server.started
        with httpx.Client(base_url=origin) as client:
            headers = {"Origin": origin, "X-Quiz-Request": "1"}
            assert client.post('/api/session', json={"password": "password"}, headers=headers).is_success
            assert client.post('/api/tournament', content=archive(), headers=headers).is_success
            cookie = client.cookies.get("quiz_host")
            query = client.get('/api/room').json()["join_url"].split("?", 1)[1]

        async def until(ws, predicate):
            async with asyncio.timeout(5):
                while True:
                    value = json.loads(await ws.recv())
                    if predicate(value):
                        return value

        async def exercise():
            async with connect(f"ws://127.0.0.1:{port}/ws?role=host", origin=origin,
                               additional_headers={"Cookie": f"quiz_host={cookie}"}, max_queue=None, close_timeout=1) as host:
                await host.send(json.dumps({"type": "host_hello"}))
                await until(host, lambda v: v["type"] == "welcome")
                players = []
                try:
                    for index in range(20):
                        ws = await connect(f"ws://127.0.0.1:{port}/ws?{query}", origin=origin, max_queue=None, close_timeout=1)
                        await ws.send(json.dumps({"type": "join", "name": f"参加者{index}"}))
                        welcome = await until(ws, lambda v: v["type"] == "welcome")
                        players.append((ws, welcome["player_id"]))
                    await host.send(json.dumps({"type": "start_question"}))
                    state = await until(host, lambda v: v["type"] == "room_state" and v["phase"] == "reading")
                    async def buzz(ws, player_id):
                        started = time.perf_counter()
                        await ws.send(json.dumps({"type": "buzz", "round_id": state["round_id"]}))
                        result = await until(ws, lambda v: v["type"] == "buzz_rejected" or
                            (v["type"] == "buzz_accepted" and v["player_id"] == player_id))
                        return result["type"] == "buzz_accepted", (time.perf_counter() - started) * 1000
                    results = await asyncio.gather(*(buzz(ws, pid) for ws, pid in players))
                    assert sum(accepted for accepted, _ in results) == 1
                    print(f"20 players: max response {max(ms for _, ms in results):.1f} ms (in-memory storage)")
                    # 確定状態は回答者に問題データを漏らさない。
                    winner_socket = players[next(i for i, (accepted, _) in enumerate(results) if accepted)][0]
                    final = await until(winner_socket, lambda v: v["type"] == "room_state" and v["phase"] == "buzzed")
                    assert final["question"] is None
                finally:
                    await asyncio.gather(*(ws.close() for ws, _ in players))
        asyncio.run(exercise())
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        listener.close()
        assert not thread.is_alive()
