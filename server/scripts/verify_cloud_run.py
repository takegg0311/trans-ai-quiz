"""検証専用大会を公開 Cloud Run 上で開始・終了する。秘密値は出力しない。

python scripts/verify_cloud_run.py --url HTTPS_URL --password-file PATH [--ai] [--restart-project PROJECT]
運用中の大会があれば409で中止する。参加URL・Cookie・パスワードはログに出さない。
"""
from __future__ import annotations

from typing import Any

import argparse
import asyncio
import io
import json
import statistics
import time
import zipfile
from pathlib import Path

import httpx
from websockets.asyncio.client import connect


def test_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("questions.csv", "batch,seq,text,answer,alt_answers\nverify,0,日本で一番高い山は何でしょう？,富士山,\nverify,1,日本の首都はどこでしょう？,東京,\n")
    return buffer.getvalue()


async def receive_until(socket: Any, predicate: Any) -> Any:
    async with asyncio.timeout(30):
        while True:
            message = json.loads(await socket.recv())
            if predicate(message):
                return message


async def update_revision(project: str) -> None:
    import subprocess
    base = ['gcloud', 'run', 'services']
    scope = ['trans-ai-quiz', '--project', project, '--region', 'asia-northeast1']

    async def describe() -> dict[str, Any]:
        command = base + ['describe'] + scope + ['--format=json(status.latestReadyRevisionName,status.traffic,status.conditions)']
        result = await asyncio.to_thread(subprocess.run, command, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('検証対象のリビジョン情報を取得できません。')
        return json.loads(result.stdout)['status']

    previous = (await describe())['latestReadyRevisionName']
    command = base + ['update'] + scope + ['--update-env-vars', f'QUIZ_VERIFY_RESTART={int(time.time())}', '--async', '--quiet']
    result = await asyncio.to_thread(subprocess.run, command, capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError('検証用リビジョン更新に失敗しました。')
    print('Revision update requested; waiting for Ready and traffic switch', flush=True)
    for _ in range(90):
        status = await describe()
        ready = status.get('latestReadyRevisionName')
        traffic = status.get('traffic', [])
        if ready != previous and any(t.get('revisionName') == ready and t.get('percent') == 100 for t in traffic):
            print('New revision is Ready and serving all traffic', flush=True)
            return
        await asyncio.sleep(1)
    raise TimeoutError('リビジョンの切替が確認できませんでした。')


async def verify(url: str, password: str, ai: bool, restart_project: str | None = None) -> None:
    headers = {"Origin": url, "X-Quiz-Request": "1"}
    failed_ai = []
    async with httpx.AsyncClient(base_url=url, timeout=90) as client:
        assert (await client.get('/api/cloud')).status_code == 200
        assert (await client.get('/api/questions')).status_code == 401
        assert (await client.get('/api/llm/health')).status_code == 401
        login = await client.post('/api/session', json={"password": password}, headers=headers)
        login.raise_for_status()
        if login.json()['active']:
            raise RuntimeError('既に大会を開催中です。検証を中止しました。')
        # 不正ZIPで大会が作られないこと。
        assert (await client.post('/api/tournament', content=b'invalid zip', headers=headers)).status_code == 422
        start = await client.post('/api/tournament?hours=0.1', content=test_zip(), headers=headers)
        start.raise_for_status()
        event_id = start.json()['id']
        try:
            room = (await client.get('/api/room')).json()
            query = room['join_url'].split('?', 1)[1]
            cookie = client.cookies.get('quiz_host')
            websocket_url = url.replace('https://', 'wss://')
            async with connect(websocket_url + '/ws?role=host', origin=url,
                               additional_headers={"Cookie": f"quiz_host={cookie}"},
                               max_queue=None, close_timeout=2) as host:
                await host.send(json.dumps({"type": "host_hello"}))
                await receive_until(host, lambda v: v['type'] == 'welcome')
                players = []
                try:
                    for index in range(20):
                        player = await connect(websocket_url + '/ws?' + query, origin=url,
                                               max_queue=None, close_timeout=2)
                        await player.send(json.dumps({"type": "join", "name": f"検証{index}"}))
                        welcome = await receive_until(player, lambda v: v['type'] == 'welcome')
                        players.append((player, welcome['player_id'], welcome['token']))
                    await host.send(json.dumps({"type": "start_question", "question_id": "verify/0"}))
                    state = await receive_until(host, lambda v: v['type'] == 'room_state' and v['phase'] == 'reading')
                    async def buzz(player: Any, player_id: Any, token: Any) -> Any:
                        started = time.perf_counter()
                        await player.send(json.dumps({"type": "buzz", "round_id": state['round_id']}))
                        result = await receive_until(player, lambda v: v['type'] == 'buzz_rejected' or
                            (v['type'] == 'buzz_accepted' and v['player_id'] == player_id))
                        return result['type'] == 'buzz_accepted', (time.perf_counter() - started) * 1000
                    results = await asyncio.gather(*(buzz(*player) for player in players))
                    assert sum(accepted for accepted, _ in results) == 1
                    latencies = [ms for _, ms in results]
                    print(f'20-player buzz: exactly one winner; winner={next(ms for accepted, ms in results if accepted):.0f}ms median={statistics.median(latencies):.0f}ms max={max(latencies):.0f}ms')
                    winner = await receive_until(host, lambda v: v['type'] == 'room_state' and v['phase'] == 'buzzed')
                    # 確定済み参加者を再接続して同一IDへ復帰する。
                    player, player_id, token = players.pop()
                    await player.close()
                    player = await connect(websocket_url + '/ws?' + query, origin=url, max_queue=None, close_timeout=2)
                    await player.send(json.dumps({"type": "join", "name": "復帰検証", "token": token}))
                    welcome = await receive_until(player, lambda v: v['type'] == 'welcome')
                    assert welcome['player_id'] == player_id
                    players.append((player, player_id, token))
                    restored = await receive_until(player, lambda v: v['type'] == 'room_state')
                    assert restored['buzzed']['player_id'] == winner['buzzed']['player_id']
                    assert restored['question'] is None
                    print('Participant reconnect: identity and confirmed answer right preserved')
                    if ai:
                        for path in ['/api/llm/health', '/api/jev/health']:
                            response = await client.get(path)
                            response.raise_for_status()
                        jev = await client.post('/api/jev/judge', json={"partial_text": "日本で一番高い山は何でしょう？"}, headers=headers)
                        jev.raise_for_status()
                        assert jev.json().get('ok'), 'Jev request failed (inspect provider configuration)'
                        opponents = [('anthropic', 'claude-sonnet-5'), ('google', 'gemini-3.7-flash'), ('xai', 'grok-4.3')]
                        errors = []
                        for vendor, model in opponents:
                            response = await client.post('/api/llm/predict', json={"vendor": vendor, "model": model,
                                "partial_text": "日本で一番高い山は何でしょう？", "complete": False}, headers=headers)
                            response.raise_for_status()
                            body = response.json()
                            if not body.get('ok'):
                                detail = str(body.get('error', body.get('violation', 'prediction failed')))
                                # 外部SDKのエラー本文は機密値を含み得るため、そのまま表示しない。
                                category = 'provider credits unavailable' if 'credit balance is too low' in detail else body.get('error_kind', 'violation')
                                errors.append(vendor)
                                print(f'AI provider {vendor}: {category}', flush=True)
                            else:
                                print(f'AI provider {vendor}: successful response', flush=True)
                        failed_ai = errors
                        if errors:
                            print('AI verification failed: ' + ', '.join(errors), flush=True)
                    if restart_project:
                        reconnect = players[0][1:]
                        await asyncio.gather(*(player.close() for player, _, _ in players))
                        players.clear()
                        await host.close()
                        await update_revision(restart_project)
                        session = await client.get('/api/session')
                        assert session.json()['id'] == event_id
                        assert session.json()['expires_at'] == start.json()['expires_at']
                        async with connect(websocket_url + '/ws?role=host', origin=url,
                                additional_headers={"Cookie": f"quiz_host={cookie}"},
                                max_queue=None, close_timeout=2) as recovered:
                            await recovered.send(json.dumps({"type": "host_hello"}))
                            paused = await receive_until(recovered, lambda v: v['type'] == 'room_state' and v.get('paused'))
                            assert paused['buzzed']['player_id'] == winner['buzzed']['player_id']
                            assert paused['remaining_questions'] == state['remaining_questions']
                            assert paused['round_id'] > state['round_id']
                            await recovered.send(json.dumps({"type": "resume"}))
                            resumed = await receive_until(recovered, lambda v: v['type'] == 'room_state' and not v.get('paused'))
                            assert resumed['buzzed'] == paused['buzzed']
                        player = await connect(websocket_url + '/ws?' + query, origin=url, max_queue=None, close_timeout=2)
                        await player.send(json.dumps({"type": "join", "name": "再起動復帰", "token": reconnect[1]}))
                        welcome = await receive_until(player, lambda v: v['type'] == 'welcome')
                        assert welcome['player_id'] == reconnect[0]
                        players.append((player, reconnect[0], reconnect[1]))
                        print('Revision restart: deadline, answer right, question deck and participant restored; explicit resume succeeded', flush=True)
                    end = await client.post('/api/tournament/end', headers=headers)
                    end.raise_for_status()
                    await receive_until(players[0][0], lambda v: v['type'] == 'error' and v['code'] == 'ended')
                    print('Manual end: connected participant notified')
                finally:
                    await asyncio.gather(*(player.close() for player, _, _ in players))
            assert (await client.get('/api/questions')).status_code == 401
            print('Ended session: protected data rejected', flush=True)
            # 数秒の大会を作り、接続済み端末の期限切れ通知を確認する。
            login = await client.post('/api/session', json={"password": password}, headers=headers)
            login.raise_for_status()
            short = await client.post('/api/tournament?hours=0.002', content=test_zip(), headers=headers)
            short.raise_for_status()
            event_id = short.json()['id']
            query = (await client.get('/api/room')).json()['join_url'].split('?', 1)[1]
            async with connect(websocket_url + '/ws?' + query, origin=url, max_queue=None, close_timeout=2) as expiring:
                await expiring.send(json.dumps({"type": "join", "name": "期限検証"}))
                await receive_until(expiring, lambda v: v['type'] == 'welcome')
                await receive_until(expiring, lambda v: v['type'] == 'error' and v['code'] == 'ended')
            print('Expiry: connected participant notified; tournament access revoked', flush=True)
        finally:
            # 障害時も今回作成した大会だけを終了する。
            session = await client.get('/api/session')
            if session.status_code == 200 and session.json().get('id') == event_id:
                await client.post('/api/tournament/end', headers=headers)
    if failed_ai:
        raise RuntimeError('AI検証未完了: ' + ', '.join(failed_ai))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--password-file', type=Path, required=True)
    parser.add_argument('--ai', action='store_true')
    parser.add_argument('--restart-project', help='指定プロジェクトのtrans-ai-quizを新リビジョンへ更新して復元を検証する')
    args = parser.parse_args()
    asyncio.run(verify(args.url.rstrip('/'), args.password_file.read_text().strip(), args.ai, args.restart_project))
