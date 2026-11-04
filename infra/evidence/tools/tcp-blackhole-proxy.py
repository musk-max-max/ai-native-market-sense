#!/usr/bin/env python3
"""A13 L74 fault injector: TCP blackhole proxy (no root needed).
mode 'drop' = accept client, buffer, never forward (packets swallowed);
mode 'pass' = flush buffered bytes to real PG and splice.
Mode is read from /tmp/a13_bh_mode on every chunk, so toggling is live.
"""
import asyncio, sys, pathlib

LISTEN = int(sys.argv[1])
UPSTREAM = ('127.0.0.1', int(sys.argv[2]))
MODE_FILE = pathlib.Path('/tmp/a13_bh_mode')

def mode():
    try:
        return MODE_FILE.read_text().strip() or 'drop'
    except FileNotFoundError:
        return 'drop'

async def handle(cr, cw):
    up_r = up_w = None
    buf = bytearray()
    upstream_done = asyncio.Event()

    async def ensure_up():
        nonlocal up_r, up_w
        if up_w is None:
            up_r, up_w = await asyncio.open_connection(*UPSTREAM)
        return up_r, up_w

    async def up_to_client():
        while True:
            data = await up_r.read(65536)
            if not data:
                break
            if mode() == 'pass':
                cw.write(data)
                await cw.drain()
            # drop mode: discard
        upstream_done.set()

    up_task = None
    try:
        while True:
            data = await cr.read(65536)
            if not data:
                break
            if mode() == 'pass':
                r, w = await ensure_up()
                if up_task is None:
                    up_task = asyncio.create_task(up_to_client())
                if buf:
                    w.write(bytes(buf)); buf.clear()
                w.write(data)
                await w.drain()
            else:
                buf.extend(data)
                if len(buf) > 1_000_000:
                    buf.clear()
    except (ConnectionResetError, BrokenPipeError):
        pass
    finally:
        try: cw.close()
        except Exception: pass
        if up_w is not None:
            try: up_w.close()
            except Exception: pass
        if up_task: up_task.cancel()

async def main():
    srv = await asyncio.start_server(handle, '127.0.0.1', LISTEN)
    async with srv:
        await srv.serve_forever()

asyncio.run(main())
