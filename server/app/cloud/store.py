"""外部保存の境界。トランザクションのコールバックは再実行可能な同期処理。"""
from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Any, Protocol, TypeVar

T = TypeVar("T")
Document = dict[str, Any]


class IStateStore(Protocol):
    def read(self, key: str) -> Document | None: ...
    def update(self, key: str, change: Callable[[Document | None], tuple[Document, T]]) -> T: ...


class FirestoreStore:
    def __init__(self, project: str | None, collection: str, database: str = "(default)") -> None:
        from google.cloud import firestore
        self._firestore = firestore
        self._client = firestore.Client(project=project, database=database)
        self._collection = self._client.collection(collection)

    def read(self, key: str) -> Document | None:
        return self._collection.document(key).get(timeout=10).to_dict()

    def watch(self, key: str, notify: Callable[[], None]):
        # Firestore の監視スレッドからイベントループへ更新を通知する。
        return self._collection.document(key).on_snapshot(lambda *_: notify())

    def update(self, key: str, change: Callable[[Document | None], tuple[Document, T]]) -> T:
        ref = self._collection.document(key)

        @self._firestore.transactional
        def commit(transaction):
            previous = ref.get(transaction=transaction).to_dict()
            value, result = change(copy.deepcopy(previous))
            if value != previous:
                transaction.set(ref, value)
            return result

        return commit(self._client.transaction(max_attempts=5))


class IObjectStore(Protocol):
    def put(self, name: str, data: bytes) -> None: ...
    def get(self, name: str) -> bytes: ...
    def delete(self, name: str) -> None: ...


class CloudStorageStore:
    def __init__(self, project: str | None, bucket: str) -> None:
        from google.cloud import storage
        self._bucket = storage.Client(project=project).bucket(bucket)

    def put(self, name: str, data: bytes) -> None:
        self._bucket.blob(name).upload_from_string(data, if_generation_match=0, timeout=60)

    def get(self, name: str) -> bytes:
        return self._bucket.blob(name).download_as_bytes(timeout=60)

    def delete(self, name: str) -> None:
        from google.api_core.exceptions import NotFound
        try:
            self._bucket.blob(name).delete(timeout=30)
        except NotFound:
            pass
