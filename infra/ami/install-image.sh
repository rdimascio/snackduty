#!/bin/bash
# Run only on a disposable reviewed Ubuntu 24.04 x86_64 image builder as root.
# All downloaded inputs must already be present with reviewed SHA256SUMS.
set -euo pipefail
test "$(id -u)" = 0
test "$(uname -sm)" = "Linux x86_64"
inputs=${1:?absolute directory of reviewed build inputs}
[[ "$inputs" = /* ]]
cd "$inputs"
# Required inputs: release.tar, bun, awscliv2.zip, cloudwatch.deb, rds-ca.pem,
# boot.py, snackday.service, cloudwatch-agent.json. Digest list comes from a
# separately reviewed build receipt; never generate it from untrusted downloads.
sha256sum --check --strict SHA256SUMS
for file in release.tar bun awscliv2.zip cloudwatch.deb rds-ca.pem boot.py snackday.service cloudwatch-agent.json install-image.sh; do
  grep -Eq "^[0-9a-f]{64}  $file$" SHA256SUMS
done
test "$(./bun --version)" = "1.3.5"
getent passwd snackday >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin snackday
install -d -m 0755 /opt/snackday/release
install -d -m 0700 /var/log/snackday
install -m 0755 bun /usr/local/bin/bun
install -m 0644 release.tar rds-ca.pem boot.py /opt/snackday/
tar --no-same-owner -xf release.tar -C /opt/snackday/release
chown -R root:root /opt/snackday
chmod -R go-w /opt/snackday
unzip -q awscliv2.zip -d aws-installer
./aws-installer/aws/install
dpkg -i cloudwatch.deb
install -m 0644 snackday.service /etc/systemd/system/snackday.service
install -m 0644 cloudwatch-agent.json /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
cat > /etc/logrotate.d/snackday <<'EOF'
/var/log/snackday/runtime.jsonl {
  daily
  rotate 7
  size 20M
  missingok
  notifempty
  copytruncate
  compress
}
EOF
systemctl daemon-reload
systemctl enable snackday amazon-cloudwatch-agent
# Do not start the application or bake credentials/staging.env into the AMI.
