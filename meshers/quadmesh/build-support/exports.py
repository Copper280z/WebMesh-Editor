"""Generate the Emscripten export list from the public C header."""
import json
from pathlib import Path
import re
import sys

header = Path(sys.argv[1]).read_text()
names = sorted(set(re.findall(r"\b(mq_[a-z_]+)\s*\(", header)))
print(json.dumps(["_malloc", "_free"] + ["_" + n for n in names]))
