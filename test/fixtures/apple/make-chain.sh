#!/bin/sh
# Builds a stand-in for Apple's App Store signing chain (root,
# intermediate and leaf, EC P-256, with Apple's marker extensions) for
# the purchase smoke test. Test-only keys; the real root is Apple's.
set -e
cd "$(dirname "$0")"
cat > ext.cnf <<'CNF'
[intermediate]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
1.2.840.113635.100.6.2.1=ASN1:NULL
[leaf]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
1.2.840.113635.100.6.11.1=ASN1:NULL
CNF
for name in root intermediate leaf; do
  openssl ecparam -name prime256v1 -genkey -noout -out $name.key
done
openssl req -new -x509 -key root.key -subj "/CN=Test Root CA - G3" -days 36500 -out root.pem
openssl req -new -key intermediate.key -subj "/CN=Test WWDR - G6" -out intermediate.csr
openssl x509 -req -in intermediate.csr -CA root.pem -CAkey root.key -CAcreateserial \
  -extfile ext.cnf -extensions intermediate -days 36500 -out intermediate.pem
openssl req -new -key leaf.key -subj "/CN=Test StoreKit Signing" -out leaf.csr
openssl x509 -req -in leaf.csr -CA intermediate.pem -CAkey intermediate.key -CAcreateserial \
  -extfile ext.cnf -extensions leaf -days 36500 -out leaf.pem
rm -f ext.cnf *.csr *.srl root.key intermediate.key
