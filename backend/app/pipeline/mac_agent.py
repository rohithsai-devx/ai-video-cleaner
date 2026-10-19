"""The agent queue, on this Mac. Laya loads here. ffmpeg stays in the Docker worker."""

import asyncio

from app.pipeline.worker import AGENT_QUEUES, serve


def main() -> None:
    asyncio.run(serve(AGENT_QUEUES))


if __name__ == "__main__":
    main()
