/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*(?:\\.spec|-spec)\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['src/**/*.ts'],
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@app/(.*)$': '<rootDir>/src/$1',
  },
};
