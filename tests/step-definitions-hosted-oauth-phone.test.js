const assert = require('node:assert/strict');
const test = require('node:test');

require('../data/step-definitions.js');

const stepDefinitions = globalThis.MultiPageStepDefinitions;

function getHostedCheckoutNodeIds(options = {}) {
  return stepDefinitions.getNodeIds({
    plusModeEnabled: true,
    plusPaymentMethod: 'paypal',
    plusHostedCheckoutIsFinalStep: true,
    ...options,
  });
}

test('hosted checkout OAuth tail runs phone verification before OAuth confirmation', () => {
  const nodeIds = getHostedCheckoutNodeIds();
  const phoneIndex = nodeIds.indexOf('post-login-phone-verification');
  const confirmIndex = nodeIds.indexOf('confirm-oauth');

  assert.notEqual(phoneIndex, -1);
  assert.notEqual(confirmIndex, -1);
  assert.ok(phoneIndex < confirmIndex);
});

test('hosted checkout bound-email relogin tail keeps phone verification before OAuth confirmation', () => {
  const nodeIds = getHostedCheckoutNodeIds({
    signupMethod: 'phone',
    phoneSignupReloginAfterBindEmailEnabled: true,
  });
  const phoneIndex = nodeIds.indexOf('post-bound-email-phone-verification');
  const confirmIndex = nodeIds.indexOf('confirm-oauth');

  assert.notEqual(phoneIndex, -1);
  assert.notEqual(confirmIndex, -1);
  assert.ok(phoneIndex < confirmIndex);
});

test('free OAuth strategy skips Plus checkout creation', () => {
  const nodeIds = stepDefinitions.getNodeIds({
    plusModeEnabled: true,
    plusAccountAccessStrategy: 'free_oauth',
    signupMethod: 'email',
  });

  assert.equal(nodeIds.includes('plus-checkout-create'), false);
  assert.equal(nodeIds.includes('plus-checkout-billing'), false);
  assert.equal(nodeIds.includes('paypal-approve'), false);
  assert.equal(nodeIds.includes('oauth-login'), true);
  assert.equal(nodeIds[nodeIds.indexOf('fill-profile') + 1], 'oauth-login');
  assert.ok(nodeIds.indexOf('post-login-phone-verification') < nodeIds.indexOf('confirm-oauth'));
});

test('free OAuth strategy is honored even when Plus mode state is off', () => {
  const nodeIds = stepDefinitions.getNodeIds({
    plusModeEnabled: false,
    plusAccountAccessStrategy: 'free_oauth',
    signupMethod: 'email',
  });

  assert.equal(nodeIds.includes('plus-checkout-create'), false);
  assert.equal(nodeIds.includes('oauth-login'), true);
  assert.equal(nodeIds[nodeIds.indexOf('fill-profile') + 1], 'oauth-login');
});
