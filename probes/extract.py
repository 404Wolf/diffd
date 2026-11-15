import sys
src=open('web/e2e/full.mjs').read()
title=sys.argv[1]; out=sys.argv[2]
helpers=src[src.index('// -- Helpers'):src.index('// -- The run')]
a=src.index(f'  await section("{title}')
b=src.index('  await section(', a+10)
head='''import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire("/home/wolf/.herdr/worktrees/diffd/mobile-sidebar/web/package.json");
const { chromium } = require("playwright");
const reviewUrl = process.argv[2]; const base = new URL(reviewUrl).origin; const shots = process.argv[3] ?? "/tmp/claude-1001/-home-wolf--herdr-worktrees-diffd-mobile-sidebar/99bf4316-5d02-485b-b337-678c76d3d834/scratchpad/shots"; mkdirSync(shots,{recursive:true});
const errors = [];
'''
run='''const browser = await chromium.launch({ executablePath: "/home/wolf/.nix-profile/bin/google-chrome-stable" });
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
try {
'''+src[a:b]+'''  check(errors.length === 0, "no errors " + errors.join(" | "));
} finally { await browser.close(); }
'''
open(out,'w').write(head+helpers+run)
