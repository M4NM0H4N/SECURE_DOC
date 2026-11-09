// Declarative pipeline for Secure Document Request and Approval Workflow.
// Requirements on the Jenkins agent (Linux): Node.js 20+ and npm, Docker with the
// Compose plugin, and the JUnit plugin. See docs/CI.md.
//
// Pipeline: checkout -> install -> lint -> unit tests -> integration/security/e2e
// tests -> build verification -> (optional, manual) deployment.
// It never deploys automatically.

pipeline {
  agent any

  options {
    timestamps()
    timeout(time: 20, unit: 'MINUTES')
    disableConcurrentBuilds() // CI MongoDB uses a fixed host port
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  parameters {
    booleanParam(name: 'DEPLOY', defaultValue: false,
      description: 'Run the deployment stage. Off by default; enable only after tests and environment config are verified.')
  }

  environment {
    CI = 'true'
    NODE_ENV = 'test'
    // Tests never use real secrets: server/tests/setupEnv.js sets a test-only JWT secret.
    MONGODB_URI_TEST = 'mongodb://localhost:27018/secure_doc_workflow_test?replicaSet=rs0&directConnection=true'
    JEST_JUNIT_OUTPUT_DIR = 'reports'
    JEST_JUNIT_OUTPUT_NAME = 'junit.xml'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
        sh 'node --version && npm --version && docker --version'
      }
    }

    stage('Install dependencies') {
      steps {
        sh 'npm ci'
      }
    }

    stage('Lint') {
      steps {
        sh 'npm run lint'
      }
    }

    stage('Start MongoDB (replica set)') {
      steps {
        sh 'docker compose -f docker-compose.ci.yml -p sdw-ci up -d --wait'
      }
    }

    stage('Unit tests') {
      steps {
        sh 'npm run test:unit'
      }
    }

    stage('Integration, security and end-to-end tests') {
      steps {
        sh 'npm run test:ci'
      }
    }

    stage('Build verification') {
      steps {
        sh 'npm run build'
      }
    }

    stage('Deploy (optional)') {
      when { expression { return params.DEPLOY } }
      steps {
        // Intentionally a placeholder: add the real deployment here once the
        // target environment, secrets (JWT_SECRET, MONGODB_URI) and HTTPS are in place.
        echo 'Deployment requested, but no deployment target is configured yet.'
      }
    }
  }

  post {
    always {
      junit allowEmptyResults: true, testResults: 'reports/junit.xml'
      sh 'docker compose -f docker-compose.ci.yml -p sdw-ci down || true'
    }
    success { echo 'All checks passed.' }
    failure { echo 'Pipeline failed: see the first failing stage above.' }
  }
}
