#!/usr/bin/env bash
# ADR-0010's checks 1–3, end to end, against real containers. Re-run it to reproduce the evidence.
#
#   docker compose -f infra/docker-compose.dev.yml up -d postgres
#   bash spikes/temporal/run.sh
#
# Uses the dev compose Postgres (container atlas-postgres on network atlas-dev_default) and creates
# databases `temporal` and `temporal_visibility` in it. Leaves containers temporal-spike and
# spike-worker running; `docker rm -f temporal-spike spike-worker` cleans up.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows rewrites /tmp etc. in docker arguments
cd "$(dirname "$0")"

NET=${NET:-atlas-dev_default}
PG=${PG:-atlas-postgres}
TEMPORAL=${TEMPORAL_VERSION:-1.32.1}
ADMIN="docker run --rm --network $NET temporalio/admin-tools:$TEMPORAL"
SQL="temporal-sql-tool --plugin postgres12 --ep $PG -p 5432 -u atlas --pw atlas"
SCHEMA=/etc/temporal/schema/postgresql/v12
DC="$(pwd)/dynamicconfig"
command -v cygpath >/dev/null && DC=$(cygpath -w "$DC")

echo "== check 3a: Temporal's schema on OUR Postgres, applied by Temporal's admin tool"
for db in temporal temporal_visibility; do $ADMIN $SQL --db $db create-database >/dev/null 2>&1 || true; done
$ADMIN sh -c "$SQL --db temporal setup-schema -v 0.0 && $SQL --db temporal update-schema -d $SCHEMA/temporal/versioned \
  && $SQL --db temporal_visibility setup-schema -v 0.0 && $SQL --db temporal_visibility update-schema -d $SCHEMA/visibility/versioned" >/dev/null 2>&1
echo "   temporal schema $(docker exec $PG psql -U atlas -d temporal -tAc 'select curr_version from schema_version'), visibility $(docker exec $PG psql -U atlas -d temporal_visibility -tAc 'select curr_version from schema_version')"

start_server() {
  docker rm -f temporal-spike >/dev/null 2>&1 || true
  docker run -d --name temporal-spike --network "$NET" \
    -v "$DC":/etc/temporal/config/dynamicconfig -e DYNAMIC_CONFIG_FILE_PATH=/etc/temporal/config/dynamicconfig/atlas.yaml \
    -e DB=postgres12 -e DB_PORT=5432 -e POSTGRES_SEEDS="$PG" -e POSTGRES_USER=atlas -e POSTGRES_PWD=atlas \
    -e DBNAME=temporal -e VISIBILITY_DBNAME=temporal_visibility -e BIND_ON_IP=0.0.0.0 \
    "temporalio/server:$TEMPORAL" >/dev/null
  for _ in $(seq 1 60); do
    $ADMIN temporal operator cluster health --address temporal-spike:7233 2>/dev/null | grep -q SERVING && return 0
    sleep 2
  done
  echo "server never SERVING"; docker logs temporal-spike | tail -20; exit 1
}
start_server
$ADMIN temporal operator namespace create --namespace atlas --retention 72h --address temporal-spike:7233 >/dev/null 2>&1 || true
echo "   server $TEMPORAL SERVING on Postgres; namespace atlas"

echo "== checks 1+2: the worker on each base image, workflow code bundled at image BUILD"
for v in "alpine|node:24-alpine|" "alpine-gcompat|node:24-alpine|gcompat" "slim|node:24-slim|"; do
  IFS='|' read -r tag base apk <<<"$v"
  if docker build -q -f Dockerfile --build-arg BASE="$base" --build-arg APK="$apk" -t "atlas-temporal-spike:$tag" . >/dev/null 2>&1; then
    echo "   $tag: image builds (bundle made at build time)"
  else
    why=$(docker build --progress=plain -f Dockerfile --build-arg BASE="$base" --build-arg APK="$apk" . 2>&1 | grep -m1 -E 'Error' | sed 's/^#[0-9]* [0-9.]* //' || true)
    echo "   $tag: FAILS — $why"
  fi
done

CLIENT="docker run --rm --network $NET -e TEMPORAL_ADDRESS=temporal-spike:7233 atlas-temporal-spike:slim node src/client.ts"
docker rm -f spike-worker >/dev/null 2>&1 || true
# As our services run: read-only root filesystem, non-root, `node src/*.ts` (strip-only TypeScript).
docker run -d --name spike-worker --network "$NET" --read-only --tmpfs /tmp --user node \
  -e TEMPORAL_ADDRESS=temporal-spike:7233 -e IMAGE=node:24-slim atlas-temporal-spike:slim >/dev/null
sleep 8
echo "   slim: $(docker logs spike-worker 2>&1 | grep -m1 'worker ready')"
echo "   slim: $(timeout 60 $CLIENT probe node-24-slim | tail -1)"

echo "== check 3b: an instance WAITING survives the server container being deleted and recreated"
ID=$(timeout 60 $CLIENT start | tail -1)
sleep 2
echo "   $ID started; rows in executions: $(docker exec $PG psql -U atlas -d temporal -tAc "select count(*) from executions where workflow_id = '$ID'")"
start_server
docker restart spike-worker >/dev/null
sleep 8
echo "   server replaced, worker restarted: $(timeout 90 $CLIENT signal "$ID" approved | tail -1)"
