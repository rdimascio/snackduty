#!/usr/bin/python3
"""Destructive, disposable GitHub Ubuntu VM test; never run on a deployment host.

The installer, launcher, unit, Bun and PostgreSQL are real. Only the AWS CLI's
Secrets Manager boundary is replaced by an explicitly synthetic fixture.
Raw subprocess output stays in memory; retained evidence is allowlisted.
"""
import base64
from collections import Counter
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path('/opt/snackday')
LOG = Path('/var/log/snackday/runtime.jsonl')
PG = '/usr/lib/postgresql/16/bin/'
checks = []
phase = 'preconditions'
canaries = []


def run(*args, data=None, check=True):
    result = subprocess.run(args, input=data, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=120)
    if check and result.returncode:
        raise RuntimeError('subprocess failed')
    return result


def require(condition):
    if not condition:
        raise RuntimeError('assertion failed')


def passed(name):
    checks.append(name)


def clean_logs(raw):
    require(all(value not in raw for value in canaries))
    require('postgresql://' not in raw and 'BEGIN PRIVATE KEY' not in raw)


def request(path, body=None):
    req = Request('http://127.0.0.1:3000' + path, data=body,
                  headers={'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin'})
    try:
        with urlopen(req, timeout=2) as response:
            return response.status, response.read(), response.headers
    except HTTPError as error:
        return error.code, error.read(), error.headers
    except (URLError, TimeoutError, ConnectionError):
        return 0, b'', {}


def prop(name):
    return run('systemctl', 'show', 'snackday', '--property=' + name, '--value').stdout.strip()


def start():
    run('systemctl', 'reset-failed', 'snackday')
    run('systemctl', 'start', 'snackday')


def stop():
    run('systemctl', 'stop', 'snackday')
    require(request('/readyz')[0] == 0)


def ready():
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if request('/readyz')[0] == 200:
            return
        # Do not hide an initial crash behind systemd's automatic restart.
        require(prop('ExecMainStatus') == '0')
        time.sleep(.25)
    raise RuntimeError('readiness timeout')


def rejected(name):
    offset = LOG.stat().st_size
    start()
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        require(request('/readyz')[0] == 0)
        require(request('/__snackday/release')[0] == 0)
        if prop('ExecMainStatus') != '0':
            require(prop('ExecMainCode') == '1')  # exited, not killed by the harness
            stop()
            delta = LOG.read_text()[offset:]
            require('runtime.ready' not in delta)
            require('runtime.boot_failed' in delta or 'runtime.startup_failed' in delta)
            passed(name)
            return
        time.sleep(.25)
    raise RuntimeError('negative boot did not fail')


def events():
    return [json.loads(line) for line in LOG.read_text().splitlines()
            if line.startswith('{') and json.loads(line).get('event') == 'runtime.ready']


def main(inputs, evidence):
    global phase
    require(os.getuid() == 0 and os.environ.get('GITHUB_ACTIONS') == 'true')
    require(Path('/proc/1/comm').read_text().strip() == 'systemd')
    require(not ROOT.exists() and not Path('/etc/snackday').exists())
    require(Path('/etc/os-release').read_text().find('VERSION_ID="24.04"') >= 0)
    require(inputs.is_absolute() and evidence.is_absolute())
    evidence.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='snackday-boot-', dir='/var/tmp'))
    postgres = pwd.getpwnam('postgres')
    os.chown(work, postgres.pw_uid, postgres.pw_gid)
    db_started = False
    fixture = None
    original_aws = None
    receipt = {'scope': 'disposable-linux-systemd-synthetic-secrets-tls-postgres',
               'stagingVerified': False, 'checks': checks, 'passed': False}
    try:
        phase = 'tls-postgres-setup'
        def pg(*args, data=None):
            return run('runuser', '-u', 'postgres', '--', *args, data=data)

        pg(PG + 'initdb', '-D', str(work / 'data'), '--locale=C', '--encoding=UTF8',
           '--auth-local=trust', '--auth-host=reject')
        run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
            '-keyout', str(work / 'data/server.key'), '-out', str(inputs / 'rds-ca.pem'))
        shutil.copyfile(inputs / 'rds-ca.pem', work / 'data/server.crt')
        os.chown(work / 'data/server.key', postgres.pw_uid, postgres.pw_gid)
        (work / 'data/server.key').chmod(0o600)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        with (work / 'data/postgresql.conf').open('a') as output:
            output.write(f"\nlisten_addresses='127.0.0.1'\nport={port}\n"
                         f"unix_socket_directories='{work}'\nssl=on\n"
                         "ssl_cert_file='server.crt'\nssl_key_file='server.key'\n"
                         "log_statement='none'\nlog_min_error_statement=panic\n")
        (work / 'data/pg_hba.conf').write_text(
            'local all all trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n'
            'hostnossl all all 127.0.0.1/32 reject\n')
        pg(PG + 'pg_ctl', '-D', str(work / 'data'), '-l', str(work / 'postgres.log'), '-w', 'start')
        db_started = True

        def sql(statement):
            # SQL (including generated credentials) uses stdin, never argv or CI output.
            return pg(PG + 'psql', '-h', str(work), '-p', str(port), '-d', 'snackday',
                      '-At', '-v', 'ON_ERROR_STOP=1', data=statement).stdout.strip()

        pg(PG + 'createdb', '-h', str(work), '-p', str(port), 'snackday')
        password = secrets.token_hex(24)
        key = base64.b64encode(secrets.token_bytes(32)).decode()
        marker = 'private-person-' + secrets.token_hex(16)
        canaries.extend((password, key, marker))
        sql(f"CREATE ROLE snackday LOGIN SUPERUSER PASSWORD '{password}';")
        state = {'mode': 'valid', 'password': password, 'key': key}
        counts = Counter()

        class SecretsFixture(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                kind = self.path.removeprefix('/')
                if kind not in ('database', 'runtime'):
                    self.send_error(404)
                    return
                counts[kind] += 1
                if state['mode'] == 'missing-' + kind:
                    self.send_response(404)
                    self.end_headers()
                    self.wfile.write(password.encode())  # deliberate sensitive provider error
                    return
                value = ({'username': 'snackday', 'password': state['password']}
                         if kind == 'database' else {'SNACKDAY_INVITATION_OUTBOX_KEY': state['key']})
                secret = json.dumps(value)
                if state['mode'] == 'malformed-' + kind:
                    secret = password + '{'
                if state['mode'] == 'empty-' + kind:
                    secret = '{}'
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'SecretString': secret}).encode())

        fixture = ThreadingHTTPServer(('127.0.0.1', 0), SecretsFixture)
        threading.Thread(target=fixture.serve_forever, daemon=True).start()
        phase = 'actual-image-install'
        # Generated TLS material is fixture input, not a production RDS CA receipt.
        names = ['release.tar', 'bun', 'awscliv2.zip', 'cloudwatch.deb', 'rds-ca.pem',
                 'boot.py', 'snackday.service', 'cloudwatch-agent.json', 'install-image.sh']
        (inputs / 'SHA256SUMS').write_text(''.join(
            hashlib.file_digest((inputs / name).open('rb'), 'sha256').hexdigest() + '  ' + name + '\n'
            for name in names))
        # Hosted runners may already carry AWS CLI; install our pinned version in a clean location.
        if Path('/usr/local/aws-cli').exists():
            shutil.move('/usr/local/aws-cli', str(work / 'runner-aws-cli'))
        for name in ('aws', 'aws_completer'):
            Path('/usr/local/bin/' + name).unlink(missing_ok=True)
        run('bash', str(inputs / 'install-image.sh'), str(inputs))
        require(run('systemctl', 'is-enabled', 'snackday').stdout.strip() == 'enabled')
        require(Path('/etc/systemd/system/snackday.service').read_bytes() == (inputs / 'snackday.service').read_bytes())
        require((ROOT / 'boot.py').read_bytes() == (inputs / 'boot.py').read_bytes())
        receipt['awsCliInstalled'] = run('/usr/local/bin/aws', '--version').stdout.strip()
        passed('actual-installer-and-unmodified-unit')

        phase = 'synthetic-secrets-boundary'
        original_aws = os.readlink('/usr/local/bin/aws')
        Path('/usr/local/bin/aws').unlink()
        # The only substituted executable. Validate the complete CLI contract and
        # return AWS-shaped JSON through the same captured stdout/stderr pipes.
        Path('/usr/local/bin/aws').write_text('''#!/usr/bin/python3
import sys
from urllib.request import urlopen
args = sys.argv[1:]
expected = ['secretsmanager', 'get-secret-value', '--secret-id', '', '--version-stage',
            'AWSCURRENT', '--region', 'us-east-1', '--output', 'json', '--no-cli-pager']
assert len(args) == len(expected)
kind = {'arn:aws:secretsmanager:us-east-1:000000000000:secret:ci-database': 'database',
        'arn:aws:secretsmanager:us-east-1:000000000000:secret:ci-runtime': 'runtime'}[args[3]]
expected[3] = args[3]
assert args == expected
try:
    with urlopen('http://127.0.0.1:FIXTURE_PORT/' + kind, timeout=5) as response:
        sys.stdout.buffer.write(response.read())
except Exception as error:
    if hasattr(error, 'read'):
        sys.stderr.buffer.write(error.read())
    sys.exit(1)
'''.replace('FIXTURE_PORT', str(fixture.server_port)))
        Path('/usr/local/bin/aws').chmod(0o755)
        commit = (inputs / 'release/release-commit.txt').read_text().strip()
        digest = 'sha256:' + hashlib.file_digest((ROOT / 'release.tar').open('rb'), 'sha256').hexdigest()
        receipt.update(releaseCommit=commit, artifactDigest=digest)
        config = {
            'AWS_REGION': 'us-east-1', 'SNACKDAY_DATABASE_HOST': '127.0.0.1',
            'SNACKDAY_DATABASE_PORT': str(port), 'SNACKDAY_DATABASE_NAME': 'snackday',
            'SNACKDAY_DATABASE_SECRET_ARN': 'arn:aws:secretsmanager:us-east-1:000000000000:secret:ci-database',
            'SNACKDAY_RUNTIME_SECRET_ARN': 'arn:aws:secretsmanager:us-east-1:000000000000:secret:ci-runtime',
            'SNACKDAY_PUBLIC_BASE_URL': 'https://ci.snackday.invalid',
            'SNACKDAY_APPLE_CLIENT_ID': 'ci.snackday.fixture',
            'SNACKDAY_RELEASE_COMMIT': commit, 'SNACKDAY_RELEASE_DIGEST': digest,
        }
        Path('/etc/snackday').mkdir(mode=0o700)

        def configure(**changes):
            Path('/etc/snackday/staging.env').write_text(''.join(
                f'{key}={value}\n' for key, value in (config | changes).items()))
            Path('/etc/snackday/staging.env').chmod(0o600)

        configure()
        phase = 'first-systemd-boot'
        start()
        ready()
        status, body, headers = request('/__snackday/release')
        require(status == 200 and json.loads(body) == {'releaseCommit': commit, 'artifactDigest': digest})
        require(headers['Cache-Control'] == 'no-store')
        require(len(events()) == 1 and len(events()[0]['migrations_applied']) == 11)
        ledger = sql('SELECT version FROM schema_migrations ORDER BY version;')
        require(len(ledger.splitlines()) == 11)
        require(sql("SELECT count(*) FROM pg_stat_ssl s JOIN pg_stat_activity a USING(pid) "
                    "WHERE a.usename='snackday' AND a.datname='snackday' AND s.ssl;") != '0')
        passed('startup-migrations-tls-readiness-release-identity')

        phase = 'runtime-privileges'
        pid = prop('MainPID')
        account = pwd.getpwnam('snackday')
        status = Path('/proc/' + pid + '/status').read_text().splitlines()
        require(next(line for line in status if line.startswith('Uid:')).split()[1:] == [str(account.pw_uid)] * 4)
        require(next(line for line in status if line.startswith('Gid:')).split()[1:] == [str(account.pw_gid)] * 4)
        require(next(line for line in status if line.startswith('Groups:')).split()[1:] == [])
        require(next(line for line in status if line.startswith('CapEff:')).split()[1] == '0000000000000000')
        require(account.pw_uid != 0 and Path('/proc/' + pid + '/exe').resolve() == Path('/usr/local/bin/bun'))
        run('runuser', '-u', 'snackday', '--', 'python3', '-c',
            "import os; from pathlib import Path; p=Path('/opt/snackday'); "
            "assert all(not os.access(x, os.W_OK) for x in [p, *p.rglob('*')])")
        require(run('runuser', '-u', 'snackday', '--', 'touch', str(ROOT / 'release/unauthorized'), check=False).returncode != 0)
        passed('non-root-empty-groups-no-capabilities-read-only-code')

        phase = 'sensitive-request-redaction'
        request('/invite/' + marker + '?token=' + password)
        request('/calendar/feed/' + marker)
        request('/api/dev/sign-in', json.dumps({'displayName': marker, 'token': password}).encode())
        require(request('/api/dev/sign-in', b'{}')[0] == 404)
        sql("INSERT INTO people (id,display_name,status,created_at,updated_at) "
            f"VALUES ('ci-persistence','{marker}','active','2026-09-16','2026-09-16');")
        phase = 'restart-and-secret-refresh'
        stop()
        before = counts.copy()
        rotated = secrets.token_hex(24)
        canaries.append(rotated)
        sql(f"ALTER ROLE snackday PASSWORD '{rotated}';")
        state['password'] = rotated
        start()
        ready()
        require(all(counts[kind] == before[kind] + 1 for kind in ('database', 'runtime')))
        require(sql("SELECT display_name FROM people WHERE id='ci-persistence';") == marker)
        require(sql('SELECT version FROM schema_migrations ORDER BY version;') == ledger)
        require(len(events()) == 2 and events()[1]['migrations_applied'] == [])
        passed('restart-persists-application-row-and-refreshes-rotated-secret')
        stop()

        phase = 'negative-boot-matrix'
        configure(SNACKDAY_RELEASE_DIGEST='sha256:' + '0' * 64)
        rejected('bad-archive-digest')
        configure(SNACKDAY_RELEASE_COMMIT='0' * 40)
        rejected('mismatched-source-commit')
        configure()
        target = ROOT / 'release/apps/web/runtime/server.ts'
        source = target.read_bytes()
        target.write_bytes(source + b'\n// modified\n')
        rejected('modified-installed-code')
        target.write_bytes(source)
        for mode in ('missing-database', 'missing-runtime', 'malformed-database',
                     'malformed-runtime', 'empty-database', 'empty-runtime'):
            state['mode'] = mode
            rejected(mode)
        state['mode'] = 'valid'
        state['key'] = 'invalid-base64'
        rejected('invalid-outbox-key')
        state['key'] = key
        ca = (ROOT / 'rds-ca.pem').read_bytes()
        (ROOT / 'rds-ca.pem').write_text('invalid CA\n')
        rejected('malformed-ca')
        run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=wrong-ca', '-keyout', str(work / 'wrong.key'), '-out', str(ROOT / 'rds-ca.pem'))
        rejected('untrusted-ca')
        (ROOT / 'rds-ca.pem').write_bytes(ca)
        phase = 'recovery-after-negative-controls'
        start()
        ready()
        stop()
        passed('valid-boot-recovers-after-negative-controls')
        phase = 'log-and-evidence-redaction'
        # SQL client output intentionally contains generated fixtures. It is captured,
        # never logged/retained; inspect actual service, journal and database logs.
        raw = LOG.read_text() + (work / 'postgres.log').read_text()
        raw += run('journalctl', '-u', 'snackday', '--no-pager', '-o', 'cat').stdout
        clean_logs(raw)
        try:
            clean_logs(raw + marker)
        except RuntimeError:
            passed('log-leak-detector-rejects-injected-canary')
        else:
            raise RuntimeError('vacuous log leak detector')
        receipt['events'] = dict(Counter(json.loads(line)['event'] for line in LOG.read_text().splitlines() if line.startswith('{')))
        receipt['secretFetches'] = dict(counts)
        receipt['migrations'] = events()[0]['migrations_applied']
        receipt['systemdVersion'] = run('systemctl', '--version').stdout.splitlines()[0]
        receipt['postgresVersion'] = run(PG + 'postgres', '--version').stdout.strip()
        passed('raw-service-journal-database-logs-contain-no-sensitive-canaries')
        for path in evidence.rglob('*'):
            if path.is_file():
                require(all(value.encode() not in path.read_bytes() for value in canaries))
        require(all(value not in json.dumps(receipt) for value in canaries))
        passed('retained-evidence-contains-no-sensitive-canaries')
        receipt['passed'] = True
    finally:
        receipt['lastPhase'] = phase
        (evidence / 'boot-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        run('systemctl', 'stop', 'snackday', check=False)
        if original_aws:
            Path('/usr/local/bin/aws').unlink(missing_ok=True)
            Path('/usr/local/bin/aws').symlink_to(original_aws)
        if fixture:
            fixture.shutdown()
        if db_started:
            run('runuser', '-u', 'postgres', '--', PG + 'pg_ctl', '-D', str(work / 'data'), '-m', 'immediate', '-w', 'stop', check=False)
        shutil.rmtree(work)
        LOG.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main(Path(sys.argv[1]), Path(sys.argv[2]))
        print('Linux image boot verification passed (synthetic Secrets Manager; no AWS deployment).')
    except Exception:
        # Never print exception text, subprocess buffers, SQL, credentials or request bodies.
        print('Linux image boot verification failed at phase: ' + phase, file=sys.stderr)
        sys.exit(1)
