# CoCo Kata-agent policy for Mode C.
#
# Enforced by kata-agent inside the confidential VM through the OPA policy
# shipped in the pod's initdata. Its purpose is to limit what the *host* can ask
# the guest agent to do: no host-originated exec, no host file access, no streams
# outside the sandbox workspace.
#
# Starting point only: review against the CoCo policy schema for the release you
# deploy (the structure changed across 0.9 -> 0.18). Not applied by the demo.
package agent_policy

import future.keywords.in

argv := input.request.process.argv

allow {
  not deny
}

is_guest_runtime {
  input.request.type == "ExecProcessRequest"
  count(argv) == 2
  argv[0] == "/usr/local/bin/x402-guest"
  argv[1] == "run"
}

# Host-originated exec is only allowed for the fixed guest entrypoint.
deny {
  input.request.type == "ExecProcessRequest"
  not is_guest_runtime
}

# The host may not read, write, copy, mount or signal inside the VM. Customer
# payloads are forked by the guest runtime, not by kata-agent.
deny {
  input.request.type in [
    "CopyFileRequest",
    "ReadStreamRequest",
    "WriteStreamRequest",
    "MountRequest",
    "SignalProcessRequest",
    "SetGuestDateTimeRequest",
  ]
}
