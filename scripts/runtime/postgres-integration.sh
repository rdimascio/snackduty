#!/usr/bin/env bash
set -euo pipefail

# Own an isolated cluster; never accept a caller's DATABASE_URL or touch its DB.
cd "$(dirname "$0")/../.."
pg_bin="${SNACKDAY_TEST_PG_BIN:-$(pg_config --bindir)}"
for executable in initdb pg_ctl psql; do
  test -x "$pg_bin/$executable" || { echo "Missing PostgreSQL executable: $executable" >&2; exit 1; }
done
cluster_dir="$(mktemp -d "${TMPDIR:-/tmp}/snackday-postgres.XXXXXX")"
cleanup() {
  "$pg_bin/pg_ctl" -D "$cluster_dir/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$cluster_dir"
}
trap cleanup EXIT
"$pg_bin/initdb" -D "$cluster_dir/data" -U snackday --locale=C --encoding=UTF8 --auth-local=trust --auth-host=reject >"$cluster_dir/init.log"
cat >"$cluster_dir/certificate.cnf" <<EOF
[req]
distinguished_name = subject
x509_extensions = extensions
[subject]
[extensions]
subjectAltName = IP:127.0.0.1,DNS:localhost
basicConstraints = critical,CA:TRUE
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -config "$cluster_dir/certificate.cnf" \
  -keyout "$cluster_dir/data/server.key" -out "$cluster_dir/data/server.crt" >/dev/null 2>&1
chmod 600 "$cluster_dir/data/server.key"
# Ask the OS for an unused loopback port. Startup itself
# remains the authority: a port race fails visibly rather than contacting another DB.
test_port="$(bun -e 'const s = Bun.listen({hostname:"127.0.0.1", port:0, socket:{data(){}}}); console.log(s.port); s.stop();')"
cat >>"$cluster_dir/data/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
port = $test_port
unix_socket_directories = '$cluster_dir'
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
EOF
cat >"$cluster_dir/data/pg_hba.conf" <<EOF
local all all trust
hostssl all all 127.0.0.1/32 scram-sha-256
hostnossl all all 127.0.0.1/32 reject
EOF
"$pg_bin/pg_ctl" -D "$cluster_dir/data" -l "$cluster_dir/server.log" -w start >/dev/null
test_password="$(openssl rand -hex 24)"
"$pg_bin/psql" -h "$cluster_dir" -p "$test_port" -U snackday -d postgres -v ON_ERROR_STOP=1 \
  -c "SET password_encryption = 'scram-sha-256'; ALTER ROLE snackday PASSWORD '$test_password';" \
  -c 'CREATE DATABASE snackday_integration' >/dev/null
SNACKDAY_TEST_POSTGRES_URL="postgresql://snackday:$test_password@127.0.0.1:$test_port/snackday_integration?sslmode=verify-full&sslrootcert=$cluster_dir/data/server.crt" \
  bun test ./apps/web/test/postgres.integration.test.ts --timeout 30000
