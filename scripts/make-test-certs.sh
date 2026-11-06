#!/bin/sh
# Creates a throwaway CA, a server certificate for "localhost" and the test containers, and SSH keys for test/compose.yaml.
# Connecting to 127.0.0.1 in verified mode must therefore fail on the host name. Nothing here is a real secret.
set -e
cd "$(dirname "$0")/../test"
rm -rf certs
mkdir -p certs/sshkeys
cd certs
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout ca.key -out ca.crt -subj "/CN=datawise test CA" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost" 2>/dev/null
printf 'subjectAltName=DNS:localhost,DNS:postgres-tls,DNS:mysql-tls,DNS:redis-tls,DNS:mongodb-tls\n' > ext.cnf
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 -out server.crt -extfile ext.cnf 2>/dev/null
cat server.key server.crt > server.pem
chmod 644 ca.crt ca.key server.* ext.cnf
ssh-keygen -q -t ed25519 -N '' -f id_plain -C datawise-test
ssh-keygen -q -t ed25519 -N 'dw-key-pass' -f id_pass -C datawise-test
ssh-keygen -q -t ed25519 -N '' -f id_wrong -C datawise-test
cp id_plain.pub id_pass.pub sshkeys/
chmod 644 sshkeys/*
