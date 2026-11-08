#!/usr/bin/env python3
"""Verify local Docker-save/config and registry manifest proofs without extraction."""

import argparse
import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path


SOURCE = "https://github.com/kindsr/devscent-pieceofdays-main"
MANIFEST_TYPES = {
    "application/vnd.oci.image.manifest.v1+json": "application/vnd.oci.image.config.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json": "application/vnd.docker.container.image.v1+json",
}


def require(condition):
    if not condition:
        raise ValueError("invalid proof")


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def is_digest(value):
    return matches(r"sha256:[0-9a-f]{64}", value)


def digest(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError("invalid JSON constant")


def document(raw):
    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=reject_constant)


def read_file(filename):
    with Path(filename).open("rb") as source:
        raw = source.read(16 * 1024 * 1024 + 1)
    require(len(raw) <= 16 * 1024 * 1024)
    return raw


def safe_name(name, directory=False):
    require(isinstance(name, str) and bool(name) and "\\" not in name and "\x00" not in name)
    if directory:
        name = name.rstrip("/")
    require(all(part not in ("", ".", "..") for part in name.split("/")))
    return name


def archive_proof(args):
    require(matches(r"[0-9a-f]{40}", args.sha) and matches(r"[0-9a-f]{40}", args.tree))
    require(matches(r"[1-9][0-9]*", args.migrations_latest))
    metadata = document(read_file(args.metadata))
    require(isinstance(metadata, dict))
    metadata_digest = metadata.get("containerimage.config.digest")
    require(is_digest(metadata_digest))
    with tarfile.open(args.archive, mode="r:") as archive:
        members = {}
        for member in archive:
            require(member.isfile() or member.isdir())
            name = safe_name(member.name, member.isdir())
            require(name not in members)
            members[name] = member

        def read_member(name):
            member = members.get(safe_name(name))
            require(member is not None and member.isfile() and 0 < member.size <= 16 * 1024 * 1024)
            with archive.extractfile(member) as source:
                raw = source.read(member.size + 1)
            require(len(raw) == member.size)
            return raw

        manifest = document(read_member("manifest.json"))
        require(isinstance(manifest, list) and len(manifest) == 1 and isinstance(manifest[0], dict))
        image = manifest[0]
        raw_config = read_member(image.get("Config"))
        layers = image.get("Layers")
        require(isinstance(layers, list) and bool(layers))
        for layer in layers:
            member = members.get(safe_name(layer))
            require(member is not None and member.isfile())
        config_digest = digest(raw_config)
        require(config_digest == metadata_digest)
        config = document(raw_config)
    require(isinstance(config, dict) and config.get("os") == "linux" and config.get("architecture") == "amd64")
    image_config = config.get("config")
    require(isinstance(image_config, dict))
    labels = image_config.get("Labels")
    require(isinstance(labels, dict))
    for key, expected in {
        "org.opencontainers.image.source": SOURCE,
        "org.opencontainers.image.revision": args.sha,
        "pod.tree": args.tree,
        "pod.migrations.latest": args.migrations_latest,
    }.items():
        require(isinstance(labels.get(key), str) and labels[key] == expected)
    return {"config_digest": config_digest, "migrations_latest": labels["pod.migrations.latest"], "metadata_keys": sorted(metadata)}


def positive_int(value):
    return type(value) is int and value > 0


def manifest_proof(args):
    require(is_digest(args.manifest_digest) and is_digest(args.config_digest))
    raw = read_file(args.manifest)
    require(digest(raw) == args.manifest_digest)
    manifest = document(raw)
    require(isinstance(manifest, dict) and "manifests" not in manifest)
    require(type(manifest.get("schemaVersion")) is int and manifest["schemaVersion"] == 2)
    media_type = manifest.get("mediaType")
    require(isinstance(media_type, str) and media_type in MANIFEST_TYPES)
    config = manifest.get("config")
    require(isinstance(config, dict))
    require(config.get("mediaType") == MANIFEST_TYPES[media_type] and config.get("digest") == args.config_digest and positive_int(config.get("size")))
    layers = manifest.get("layers")
    require(isinstance(layers, list) and bool(layers))
    for layer in layers:
        require(isinstance(layer, dict))
        require(is_digest(layer.get("digest")) and positive_int(layer.get("size")) and isinstance(layer.get("mediaType"), str))
    return {"manifest_digest": args.manifest_digest, "config_digest": args.config_digest, "media_type": media_type}


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        raise ValueError("invalid arguments")


def main():
    try:
        parser = Parser(add_help=False, allow_abbrev=False)
        commands = parser.add_subparsers(dest="mode", required=True)
        archive = commands.add_parser("archive", add_help=False, allow_abbrev=False)
        for name in ("metadata", "archive", "sha", "tree", "migrations-latest"):
            archive.add_argument("--" + name, required=True)
        manifest = commands.add_parser("manifest", add_help=False, allow_abbrev=False)
        for name in ("manifest", "manifest-digest", "config-digest"):
            manifest.add_argument("--" + name, required=True)
        args = parser.parse_args()
        result = archive_proof(args) if args.mode == "archive" else manifest_proof(args)
    except Exception:
        # Fixed diagnostics never include a supplied path, JSON value or exception.
        sys.stderr.write("verify-image: invalid image proof\n")
        return 1
    sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
