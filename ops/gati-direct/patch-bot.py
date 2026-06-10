#!/usr/bin/env python3
"""Idempotent injector for the Gati SJE direct-ingress patch into the OpenClaw
compiled Telegram bot bundle.

Usage:
    patch-bot.py <bot_file_path> <helpers_path>
"""
import re
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: patch-bot.py <bot_file> <helpers>", file=sys.stderr)
        return 2
    bot_path = Path(sys.argv[1])
    helpers_path = Path(sys.argv[2])

    src = bot_path.read_text()
    helpers = helpers_path.read_text().rstrip() + "\n"

    # Strip any prior helper block (idempotent re-apply).
    helper_pat = re.compile(
        r'const GATI_DIRECT_WORKSPACE = "/home/openclaw.*?\nasync function tryHandleGatiSjeDirectIngress\([\s\S]*?\n\}\n',
        re.DOTALL,
    )
    src = helper_pat.sub("", src)

    # Strip any prior call-site block (idempotent re-apply).
    call_pat = re.compile(
        r"\t\tif \(await tryHandleGatiSjeDirectIngress\(context, account\)\) \{\n[\s\S]*?\n\t\t\}\n",
    )
    src = call_pat.sub("", src)

    # Anchor 1: insert helpers before `const createTelegramMessageProcessor =`.
    anchor1 = "const createTelegramMessageProcessor = (deps) =>"
    if anchor1 not in src:
        print("GATI_PATCH_FAIL anchor1_missing", file=sys.stderr)
        return 10
    src = src.replace(anchor1, helpers + anchor1, 1)

    # Anchor 2: insert call site immediately before the typing-cue line in the
    # Telegram inbound dispatch. The compiled bundle changed this line to add
    # an initialTypingCueSent guard, so accept either form.
    anchor2_options = [
        '\t\tif (context.ctxPayload.InboundEventKind !== "room_event" && context.initialTypingCueSent !== true) context.sendTyping()',
        '\t\tif (context.ctxPayload.InboundEventKind !== "room_event") context.sendTyping()',
    ]
    anchor2 = next((anchor for anchor in anchor2_options if anchor in src), None)
    if anchor2 is None:
        print("GATI_PATCH_FAIL anchor2_missing", file=sys.stderr)
        return 11
    call_block = (
        "\t\tif (await tryHandleGatiSjeDirectIngress(context, account)) {\n"
        "\t\t\tif (ingressDebugEnabled && ingressReceivedAtMs) logVerbose(`telegram ingress: "
        "chatId=${context.chatId} gatiDirectHandledMs=${Date.now() - ingressReceivedAtMs}`"
        " + (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : \"\"));\n"
        "\t\t\treturn;\n"
        "\t\t}\n"
    )
    src = src.replace(anchor2, call_block + anchor2, 1)

    bot_path.write_text(src)
    print(f"GATI_PATCH_APPLIED file={bot_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
