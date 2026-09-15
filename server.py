#!/usr/bin/env python3
"""Serve Calendurr and bridge its task API to a local TaskWarrior install."""

from __future__ import annotations

import json
import shutil
import subprocess
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8787
UDA_SETTINGS = (
    ("uda.calendurr_description.type", "string"),
    ("uda.calendurr_description.label", "Description"),
    ("uda.calendurr_priority_order.type", "numeric"),
    ("uda.calendurr_priority_order.label", "Calendurr order"),
)


class ApiError(Exception):
    def __init__(self, message: str, status: int = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


def task_command(arguments: list[str], input_text: str | None = None) -> str:
    if not shutil.which("task"):
        raise ApiError("TaskWarrior is not installed on this server.", HTTPStatus.SERVICE_UNAVAILABLE)
    result = subprocess.run(
        ["task", "rc.confirmation=no", "rc.verbose=nothing", *arguments],
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise ApiError(result.stderr.strip() or "TaskWarrior command failed.", HTTPStatus.BAD_GATEWAY)
    return result.stdout


def ensure_udas() -> None:
    for key, value in UDA_SETTINGS:
        task_command(["config", key, value])


def task_date(value: str | None) -> str | None:
    return value[:8] if value and len(value) >= 8 else None


def map_task(task: dict) -> dict | None:
    date = task_date(task.get("due"))
    if not date:
        return None
    priority = task.get("calendurr_priority_order", 0)
    return {
        "id": task["uuid"],
        "title": task.get("description", ""),
        "description": task.get("calendurr_description", ""),
        "date": f"{date[:4]}-{date[4:6]}-{date[6:8]}",
        "labels": task.get("tags", []),
        "project": task.get("project", ""),
        "priorityOrder": int(priority or 0),
        "status": "done" if task.get("status") == "completed" else task.get("status", "todo"),
    }


def all_tasks() -> list[dict]:
    ensure_udas()
    records: dict[str, dict] = {}
    for status in ("pending", "waiting", "completed"):
        output = task_command([f"status:{status}", "export"])
        for record in json.loads(output or "[]"):
            records[record["uuid"]] = record
    return sorted(
        (mapped for record in records.values() if (mapped := map_task(record))),
        key=lambda task: (task["date"], task["priorityOrder"], task["title"]),
    )


def validate_task(payload: dict) -> dict:
    title = str(payload.get("title", "")).strip()
    date = str(payload.get("date", "")).strip()
    labels = payload.get("labels", [])
    if not isinstance(labels, list):
        raise ApiError("labels must be an array.")
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError as error:
        raise ApiError("Tasks require a date in YYYY-MM-DD format.") from error
    if not title:
        raise ApiError("Tasks require a title.")
    try:
        priority_order = int(payload.get("priorityOrder", 0) or 0)
    except (TypeError, ValueError) as error:
        raise ApiError("priorityOrder must be an integer.") from error
    return {
        "title": title,
        "description": str(payload.get("description", "")).strip(),
        "date": date,
        "labels": [str(label).strip() for label in labels if str(label).strip()],
        "project": str(payload.get("project", "")).strip(),
        "priorityOrder": priority_order,
        "status": str(payload.get("status", "todo")),
    }


def modify_task(task_id: str, task: dict) -> None:
    arguments = [task_id, "modify", f"description:{task['title']}", f"due:{task['date']}", f"project:{task['project']}", f"calendurr_description:{task['description']}", f"calendurr_priority_order:{task['priorityOrder']}"]
    existing = next((item for item in all_tasks() if item["id"] == task_id), None)
    if not existing:
        raise ApiError("Task not found.", HTTPStatus.NOT_FOUND)
    arguments.extend(f"-{label}" for label in existing["labels"])
    arguments.extend(f"+{label}" for label in task["labels"])
    task_command(arguments)
    if task["status"] == "done" and existing["status"] != "done":
        task_command([task_id, "done"])
    elif task["status"] != "done" and existing["status"] == "done":
        task_command([task_id, "modify", "status:pending"])


class CalendurrHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format: str, *args) -> None:
        print(format % args)

    def send_json(self, payload: object, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as error:
            raise ApiError("Request body must be valid JSON.") from error
        if not isinstance(payload, dict):
            raise ApiError("Request body must be a JSON object.")
        return payload

    def handle_api(self) -> bool:
        path = urlparse(self.path).path
        try:
            if path == "/api/health" and self.command == "GET":
                ensure_udas()
                self.send_json({"service": "taskwarrior", "status": "ready"})
            elif path == "/api/tasks" and self.command == "GET":
                self.send_json(all_tasks())
            elif path == "/api/tasks" and self.command == "POST":
                ensure_udas()
                task = validate_task(self.read_json())
                task_id = str(uuid.uuid4())
                record = {
                    "uuid": task_id,
                    "description": task["title"],
                    "status": "pending",
                    "entry": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
                    "due": f"{task['date'].replace('-', '')}T000000Z",
                    "tags": task["labels"],
                    "project": task["project"],
                    "calendurr_description": task["description"],
                    "calendurr_priority_order": task["priorityOrder"],
                }
                task_command(["import"], json.dumps(record))
                if task["status"] == "done":
                    task_command([task_id, "done"])
                self.send_json({"id": task_id, **task}, HTTPStatus.CREATED)
            elif path.startswith("/api/tasks/") and self.command in ("PUT", "DELETE"):
                task_id = unquote(path.rsplit("/", 1)[1])
                if self.command == "DELETE":
                    task_command([task_id, "delete"])
                    self.send_json({"id": task_id})
                else:
                    task = validate_task(self.read_json())
                    modify_task(task_id, task)
                    self.send_json({"id": task_id, **task})
            elif path == "/api/tasks/reorder" and self.command == "POST":
                ensure_udas()
                items = self.read_json().get("tasks", [])
                if not isinstance(items, list):
                    raise ApiError("tasks must be an array.")
                try:
                    updates = [
                        (str(item["id"]), int(item["priorityOrder"]))
                        for item in items if isinstance(item, dict)
                    ]
                except (KeyError, TypeError, ValueError) as error:
                    raise ApiError("each reordered task needs an id and priorityOrder.") from error
                if len(updates) != len(items):
                    raise ApiError("each reordered task must be an object.")
                for task_id, priority_order in updates:
                    task_command([task_id, "modify", f"calendurr_priority_order:{priority_order}"])
                self.send_json(all_tasks())
            else:
                return False
            return True
        except ApiError as error:
            self.send_json({"error": str(error)}, error.status)
            return True

    def do_GET(self) -> None:
        if self.path.startswith("/api/") and self.handle_api():
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.handle_api():
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_PUT(self) -> None:
        if self.handle_api():
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        if self.handle_api():
            return
        self.send_error(HTTPStatus.NOT_FOUND)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), CalendurrHandler)
    print(f"Calendurr is running at http://{HOST}:{PORT}")
    server.serve_forever()
