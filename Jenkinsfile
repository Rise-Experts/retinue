// CI on Jenkins, alongside the self-hosted GitHub Actions runner.
//
// Two CI systems describing one pipeline is a real risk, not a theoretical one: the failure mode is that a check
// exists in one and not the other, and the one nobody watches is the one that stops catching things. So the
// stages below are not maintained by hand against `ci.yml` — `scripts/ci-local.mjs --verify` reads this file, the
// workflow and its own step list, and fails if any of the three runs a command the others do not. That check runs
// inside `npm test`, so a drift is a failing build rather than a discovery.
//
// What Jenkins has no equivalent of is the workflow's `services:` block. GitHub starts the service containers,
// waits for their health checks and tears them down; here that is explicit — `docker run`, a readiness wait, and
// a `post { always }` cleanup that runs even when a stage throws. The readiness wait is the part worth reading:
// starting a container is not the same as the server inside it accepting connections, and a test suite that
// connects one second too early fails in a way that looks like a flaky test.
pipeline {
  // A label rather than `any`: the pipeline needs Docker and Node, and a build that lands on an agent without
  // them fails at the first stage with an error about a missing binary rather than about scheduling.
  agent { label 'linux' }

  options {
    // Fixed host ports (6479, 5442) mean two builds cannot run at once — the second would fail on EADDRINUSE and
    // read as a broken test. Serialising is the honest fix; dynamic port allocation would mean plumbing a port
    // through every stage's environment, and this pipeline is not busy enough to earn that.
    disableConcurrentBuilds()
    timestamps()
    // A hung `npm ci` or a wedged container should not hold the agent overnight.
    timeout(time: 45, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  environment {
    // The same non-default ports the workflow uses, and for the same reason: an agent is a server that probably
    // already runs a Redis and a Postgres.
    RETINUE_TEST_REDIS_URL = 'redis://localhost:6479'
    RETINUE_TEST_PG_URL    = 'postgres://postgres:postgres@localhost:5442/agentkit_test'
    // Per-build container names, so a leaked container from an earlier build cannot be mistaken for this one's.
    REDIS_NAME = "retinue-ci-redis-${env.BUILD_NUMBER}"
    PG_NAME    = "retinue-ci-pg-${env.BUILD_NUMBER}"
    // npm writes to $HOME; a Jenkins agent's HOME is not always writable by the build user.
    npm_config_cache = "${env.WORKSPACE}/.npm"
    // JUnit XML, which is the reason to have Jenkins at all rather than only the Actions UI: a console log says
    // what happened this build, and a trend says "this test has failed 3 of the last 20". Read by
    // `vitest.shared.ts`, so the suites run **once** and emit both reporters.
    RETINUE_JUNIT_DIR = "${env.WORKSPACE}/reports"
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
        // What commit this is, in the log. A build log that does not say what it built is a build log nobody can
        // use to answer "was that fixed before or after".
        sh 'git --no-pager log -1 --oneline'
      }
    }

    stage('Preflight') {
      steps {
        // Fail here, with a sentence, rather than three stages later with a stack trace. The three things this
        // pipeline cannot proceed without are Node, Docker, and Docker usable *as this user* — the last is the
        // one people miss, because `docker` being on PATH says nothing about group membership.
        sh '''
          set -e
          command -v node >/dev/null || { echo "✗ node is not installed on this agent (needs 20+)"; exit 2; }
          node --version
          command -v docker >/dev/null || { echo "✗ docker is not installed; three stages need service containers"; exit 2; }
          docker info >/dev/null 2>&1 || { echo "✗ docker is present but not usable as $(whoami) — add the user to the docker group"; exit 2; }
        '''
      }
    }

    stage('Services') {
      steps {
        sh '''
          set -e
          docker rm -f "$REDIS_NAME" "$PG_NAME" >/dev/null 2>&1 || true
          docker run -d --name "$REDIS_NAME" -p 6479:6379 redis:7-alpine >/dev/null
          docker run -d --name "$PG_NAME" -p 5442:5432 \
            -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=agentkit_test postgres:16 >/dev/null

          # Waited for, not slept on. `docker run` returns when the container starts, which is before the server
          # inside it accepts connections — and a suite that connects one second early fails like a flaky test.
          for i in $(seq 30); do
            docker exec "$REDIS_NAME" redis-cli ping 2>/dev/null | grep -q PONG && break
            [ "$i" = 30 ] && { echo "✗ redis never answered PING"; docker logs "$REDIS_NAME"; exit 1; }
            sleep 1
          done
          for i in $(seq 60); do
            docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1 && break
            [ "$i" = 60 ] && { echo "✗ postgres never became ready"; docker logs "$PG_NAME"; exit 1; }
            sleep 1
          done
          echo "✓ redis on 6479, postgres on 5442"
        '''
      }
    }

    stage('Install') {
      // `npm ci`, matching the workflow: it installs exactly the lockfile, so a build cannot pass against a
      // dependency tree nobody committed.
      steps { sh 'npm ci' }
    }

    stage('Typecheck') { steps { sh 'npm run typecheck' } }
    stage('Build')     { steps { sh 'npm run build' } }

    stage('Test') {
      // Carries `npm test`, which is itself the boundary tests, the reachability guard, the script-import guard,
      // the documented-import guard, and the check that this file has not drifted from `ci.yml`.
      steps {
        sh 'mkdir -p reports'
        sh 'npm test'
      }
      post {
        always {
          /**
           * `always`, and `allowEmptyResults: false`.
           *
           * A build whose suite crashed before writing XML would otherwise publish nothing and show a green
           * trend line — the worst available outcome, because the trend is the thing being trusted. Failing on
           * empty results means "no tests reported" is a build failure rather than a quiet gap in the graph.
           */
          junit testResults: 'reports/*.junit.xml', allowEmptyResults: false
        }
      }
    }

    stage('Boundaries')    { steps { sh 'npm run check:boundaries' } }
    stage('Eval coverage') { steps { sh 'npm run evals:coverage' } }

    stage('Conformance') {
      steps {
        sh 'npm run conformance:report'
        // Runs even if the suite failed, because a regression must still publish the table — a job that fails
        // without showing which cell broke sends someone reading logs.
        sh 'npm run conformance:matrix'
      }
      post {
        always { archiveArtifacts artifacts: 'docs/conformance-matrix.md', allowEmptyArchive: true }
      }
    }

    stage('Docs') { steps { sh 'npm --prefix website run build' } }

    stage('Image') {
      steps {
        sh 'docker build -t retinue:ci-${BUILD_NUMBER} .'
        // Liveness with no database, exactly as the workflow's image job checks it: a process that exits because
        // a dependency is missing turns a dependency blip into a restart storm.
        sh '''
          set -e
          NAME="retinue-ci-app-${BUILD_NUMBER}"
          docker rm -f "$NAME" >/dev/null 2>&1 || true
          docker run -d --name "$NAME" -p 4099:4000 \
            -e RETINUE_DATABASE_URL=postgres://nobody@127.0.0.1:1/none \
            -e RETINUE_REDIS_URL=redis://127.0.0.1:1 \
            -e RETINUE_EXAMPLE_DEV_AUTH=1 \
            retinue:ci-${BUILD_NUMBER} >/dev/null
          code=000
          for i in $(seq 20); do
            code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4099/healthz || true)
            [ "$code" = "200" ] && break
            sleep 1
          done
          docker logs "$NAME" || true
          docker rm -f "$NAME" >/dev/null 2>&1 || true
          [ "$code" = "200" ] || { echo "✗ /healthz answered $code with no database; it must stay 200"; exit 1; }
          echo "✓ /healthz 200 with no database"
        '''
      }
      post {
        always { sh 'docker rmi -f retinue:ci-${BUILD_NUMBER} >/dev/null 2>&1 || true' }
      }
    }
  }

  post {
    always {
      // `always`, and unconditional `|| true`: a leaked Postgres holds 5442 and every later build fails on a
      // port clash that has nothing to do with the change being tested.
      sh 'docker rm -f "$REDIS_NAME" "$PG_NAME" >/dev/null 2>&1 || true'
    }
    failure {
      echo 'Failed. `npm run ci:local` runs the same commands on a workstation.'
    }
  }
}
