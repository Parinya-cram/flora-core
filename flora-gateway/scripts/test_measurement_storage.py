"""Exercise real collector/API SQL against a disposable PostgreSQL container.

Run from any directory: python flora-gateway/scripts/test_measurement_storage.py
Requires Docker. Uses synthetic records, no published ports or existing database.
"""
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python/device-medical-service"))
from device_medical_service.envelope import RawFrame, encode
from device_medical_service.parsers import load_parser
from device_medical_service.parsers.draeger.medibus.parser import packet


def run(*args):
    return subprocess.check_output(args, text=True, encoding="utf-8").strip()


def main():
    name = "flora-measurement-test-" + uuid.uuid4().hex[:10]
    run("docker", "run", "-d", "--name", name, "--tmpfs", "/var/lib/postgresql/data",
        "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.6-alpine")

    def sql(statement):
        return subprocess.run(["docker", "exec", "-i", name, "psql", "-U", "postgres", "-qAt",
                               "-v", "ON_ERROR_STOP=1"], input=statement, text=True,
                              encoding="utf-8", capture_output=True, check=True).stdout.strip()

    try:
        for _ in range(40):
            if subprocess.run(["docker", "exec", name, "pg_isready", "-U", "postgres"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError("temporary Postgres did not become ready")

        sql((ROOT / "db/0001-gateway.sql").read_text())
        sql("INSERT INTO gateway_observation (device_id, ivy_param, value, system_ts) VALUES ('existing', 'hr', '72', 1);")
        migration = (ROOT / "db/0002-device-measurements.sql").read_text()
        sql(migration)
        sql(migration)  # Re-applying is safe, existing observations survive.
        assert sql("SELECT count(*) FROM gateway_observation;") == "1"

        parser = load_parser("medibus", "test-atlan", "serial.test")
        encoding, payload = encode(packet(0x24, b'D6  14B9 8.5A5----', response=True)
                                   + packet(0x29, b'04 0.45', response=True))
        parser.feed(RawFrame("serial.test", "serial", "gw-test", 1, 1000, encoding, payload))
        original = parser.drain_measurements()
        collector = (ROOT / "rust/crates/collector/src/main.rs").read_text()
        insert = re.search(r'const INSERT_MEASUREMENTS: &str = r#"(.*?)"#;', collector, re.S).group(1)
        document = json.dumps(original).replace("'", "''")
        sql(insert.replace("$1", "'" + document + "'") + ";")

        server = (ROOT / "rust/crates/server/src/main.rs").read_text().split("async fn measurements(", 1)[1]
        query = re.search(r'r#"(.*?)"#', server, re.S).group(1)

        def read(after=0, leaf="NULL", device="'test-atlan'", limit=100):
            return json.loads(sql("PREPARE read_measurements(bigint,bigint,bigint,text,text,bigint) AS "
                                  + query + f"; EXECUTE read_measurements(0,2000,{after},{device},{leaf},{limit});"))

        rows = read()
        assert len(rows) == 4
        for row, expected in zip(rows, original):
            row.pop("id")
            assert row == expected, (row, expected)
        first = read(limit=1)
        assert len(read(after=first[0]["id"])) == 3
        assert read(device="'other-device'") == []
        assert read(leaf="'other-leaf'") == []
        sql("INSERT INTO gateway_device_type(code,label,protocol,controller,parser,image) VALUES ('test','test','medibus','serial','medibus','test');"
            "INSERT INTO gateway_device_instance(device_id,device_type,pod,leaf_id,created_at,updated_at) VALUES ('test-atlan','test','serial.test','test-leaf',0,0);")
        assert len(read(leaf="'test-leaf'")) == 4
        assert sql("SELECT count(*) FROM gateway_observation;") == "1"
        print("PASS: migration, original fields, unknown/unavailable values, conversion separation, API pagination and device/Leaf filters")
    finally:
        run("docker", "rm", "-f", name)


if __name__ == "__main__":
    main()
