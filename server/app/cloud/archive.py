"""有界 ZIP 検証。公開ディレクトリへ直接展開しない。"""
from __future__ import annotations

import csv
import io
import re
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from ..quiz import Question, QuizDataError, load_questions

MAX_ZIP_BYTES = 24 * 1024 * 1024
MAX_EXPANDED_BYTES = 192 * 1024 * 1024
MAX_FILES = 4096
MAX_RATIO = 200
MAX_QUESTIONS = 2000


def unpack(data: bytes, target: Path) -> list[Question]:
    if len(data) > MAX_ZIP_BYTES:
        raise QuizDataError("ZIP は24 MiB以下にしてください。")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_FILES:
                raise QuizDataError("ZIP のファイル数が上限を超えています。")
            total = 0
            seen: set[str] = set()
            for entry in entries:
                path = PurePosixPath(entry.filename)
                mode = entry.external_attr >> 16
                if (path.is_absolute() or ".." in path.parts or "\\" in entry.filename
                        or ":" in entry.filename or "\x00" in entry.filename
                        or stat.S_ISLNK(mode) or entry.flag_bits & 1
                        or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
                    raise QuizDataError("ZIP に許可されないパス・ファイルがあります。")
                name = str(path)
                if name in seen:
                    raise QuizDataError("ZIP に重複パスがあります。")
                seen.add(name)
                total += entry.file_size
                if (total > MAX_EXPANDED_BYTES
                        or entry.file_size > max(entry.compress_size, 1) * MAX_RATIO):
                    raise QuizDataError("ZIP の展開容量または圧縮率が上限を超えています。")
                destination = target.joinpath(*path.parts)
                if entry.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as source, destination.open("wb") as output:
                    remaining = entry.file_size
                    while chunk := source.read(min(65536, remaining + 1)):
                        remaining -= len(chunk)
                        if remaining < 0:
                            raise QuizDataError("ZIP の展開サイズが不正です。")
                        output.write(chunk)
            csv_path = target / "questions.csv"
            if not csv_path.is_file():
                raise QuizDataError("ZIP のルートに questions.csv が必要です。")
            with csv_path.open(encoding="utf-8-sig", newline="") as source:
                for index, row in enumerate(csv.DictReader(source)):
                    if index >= MAX_QUESTIONS:
                        raise QuizDataError("問題数は2000問以下にしてください。")
                    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", row.get("batch") or ""):
                        raise QuizDataError("batch は英数字・ハイフン・アンダースコアで指定してください。")
            return load_questions(target)
    except (zipfile.BadZipFile, csv.Error, UnicodeError, OSError, ValueError, RuntimeError) as error:
        raise QuizDataError("ZIP または CSV を読み込めません。") from error


def validate(data: bytes) -> list[Question]:
    with tempfile.TemporaryDirectory(prefix="quiz-validate-") as directory:
        return unpack(data, Path(directory))
