# Native evidence artifacts

Drop versioned JSON captures here to publish recorded CUDA/FPGA evidence.

The site ingests only `*.json` files that pass `shipoftheseus.native-evidence` schema version 1. Each artifact must include hardware, workload, units, source repository, exact source revision, and capture provenance. Synthetic parser fixtures belong in `test/fixtures/native-evidence/`, not in this directory.

Do not invent benchmark numbers. If a capture is not a measured native result, leave this directory empty; the UI will show the empty recorded-evidence state instead of implying browser CUDA or FPGA execution.
