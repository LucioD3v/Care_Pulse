"""Build a Lambda ZIP from an installation containing production dependencies."""

import argparse
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("archive", type=Path)
args = parser.parse_args()
source = args.source.resolve()
if not (source / "package.json").is_file() or not (source / "node_modules").is_dir():
    parser.error("The source must contain package.json and installed production dependencies.")

excluded = {"seed_demo.js", "backfill_followup_index.js"}
files = [file for file in source.glob("*.js") if file.name not in excluded]
files.extend(source / name for name in ("package.json", "package-lock.json"))
for directory in ("apl", "handlers", "tools", "node_modules"):
    files.extend(file for file in (source / directory).rglob("*") if file.is_file())

args.archive.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(args.archive, "w", compression=ZIP_DEFLATED) as archive:
    for file in sorted(files):
        archive.write(file, file.relative_to(source).as_posix())
print(f"Packaged {len(files)} files into {args.archive.name}.")
