const { execFileSync } = require('node:child_process');

/**
 * Reporter обязательного test gate: печатает воспроизводимую машинную сводку и
 * превращает любой skipped test/suite в ошибку процесса.
 */
class RequiredTestReporter {
  constructor(globalConfig) {
    this.globalConfig = globalConfig;
    this.error = null;
  }

  onRunComplete(_contexts, result) {
    let pnpmVersion = 'unknown';
    try {
      pnpmVersion = execFileSync('corepack', ['pnpm', '--version'], {
        encoding: 'utf8',
      }).trim();
    } catch {
      // Отсутствующая версия попадёт в отчёт как unknown и будет поймана preflight.
    }

    const summary = {
      node: process.version,
      pnpm: pnpmVersion,
      seed: this.globalConfig.seed,
      randomize: this.globalConfig.randomize,
      suites: {
        passed: result.numPassedTestSuites,
        failed: result.numFailedTestSuites,
        skipped: result.numPendingTestSuites,
        total: result.numTotalTestSuites,
      },
      tests: {
        passed: result.numPassedTests,
        failed: result.numFailedTests,
        skipped: result.numPendingTests,
        total: result.numTotalTests,
      },
    };
    if (!this.globalConfig.suppressSummary) {
      process.stdout.write(`JEST_REQUIRED_SUMMARY ${JSON.stringify(summary)}\n`);
    }

    const isIntentionalNameFilter = Boolean(this.globalConfig.testNamePattern);
    if (
      !isIntentionalNameFilter &&
      (result.numPendingTestSuites > 0 || result.numPendingTests > 0)
    ) {
      this.error = new Error(
        `Mandatory Jest run contains skipped coverage: ${result.numPendingTestSuites} suites, ${result.numPendingTests} tests`,
      );
    }
  }

  getLastError() {
    return this.error;
  }
}

module.exports = RequiredTestReporter;
