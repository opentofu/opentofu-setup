#!/usr/bin/env node
/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

const io = require('@actions/io');
const core = require('@actions/core');
const { exec } = require('@actions/exec');

const OutputListener = require('./lib/output-listener');
const pathToCLI = require('./lib/tofu-bin');

async function checkTofu () {
  // Setting check to `true` will cause `which` to throw if tofu isn't found
  const check = true;
  return io.which(pathToCLI, check);
}

(async () => {
  // This will fail if tofu isn't found, which is what we want
  await checkTofu();

  // Create listeners to receive output (in memory) as well
  const stdout = new OutputListener();
  const stderr = new OutputListener();
  const listeners = {
    stdout: stdout.listener,
    stderr: stderr.listener
  };

  // Execute tofu and capture output
  const args = process.argv.slice(2);
  const options = {
    listeners,
    ignoreReturnCode: true,
    silent: true // don't print "[command...]" into stdout: https://github.com/actions/toolkit/issues/649
  };
  const exitCode = await exec(pathToCLI, args, options);

  // Pass-through stdout/err as `exec` won't due to `silent: true` option
  process.stdout.write(stdout.contents);
  process.stderr.write(stderr.contents);

  // Set outputs, result, exitcode, and stderr
  core.setOutput('stdout', stdout.contents);
  core.setOutput('stderr', stderr.contents);
  core.setOutput('exitcode', exitCode.toString(10));

  if (exitCode === 0 || exitCode === 2) {
    // A exitCode of 0 is considered a success
    // An exitCode of 2 may be returned when the '-detailed-exitcode' option
    // is passed to plan. This denotes Success with non-empty
    // diff (changes present).
    return;
  }

  // A non-zero exitCode is considered an error
  core.setFailed(`OpenTofu exited with code ${exitCode}.`);
})();
