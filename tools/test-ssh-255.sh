#!/bin/sh
# Test double: an ssh that cannot connect.
echo "ssh: connect to host w port 22: Connection refused" >&2
exit 255
