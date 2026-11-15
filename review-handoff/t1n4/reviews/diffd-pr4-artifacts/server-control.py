import subprocess, pathlib, time, os, signal, sys
base=pathlib.Path('/home/wolf/herdr-android/reviews/diffd-pr4-artifacts')
pidfile=base/'server.pid'
cmd=['/home/wolf/.herdr/worktrees/diffd/review-pr1/target/release/diffd','--port','43461','--bind','127.0.0.1','--public-url','http://localhost:43461','--config','/tmp/diffd-pr1-review-config.toml','--db','/tmp/diffd-pr4-7ae5208.db']
if sys.argv[1]=='record':
 for p in pathlib.Path('/proc').iterdir():
  if not p.name.isdigit(): continue
  try: args=(p/'cmdline').read_bytes().split(b'\0')
  except OSError: continue
  if len(args)>3 and args[0].endswith(b'/diffd') and args[1:3]==[b'--port',b'43461']:
   pidfile.write_text(p.name); print('Own server PID',p.name)
elif sys.argv[1]=='stop':
 pid=int(pidfile.read_text()); args=pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
 assert args[0].endswith(b'/diffd') and args[1:3]==[b'--port',b'43461'], args
 os.kill(pid, signal.SIGTERM)
elif sys.argv[1]=='start':
 with (base/'server.log').open('ab') as log:
  env=os.environ.copy(); env['PATH']='/tmp/diffd-pr1-tools:'+env['PATH']; p=subprocess.Popen(cmd, stdout=log, stderr=log, start_new_session=True,env=env)
 pidfile.write_text(str(p.pid)); time.sleep(1)
