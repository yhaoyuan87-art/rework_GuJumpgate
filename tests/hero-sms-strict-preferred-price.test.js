const assert = require('node:assert/strict');
const test = require('node:test');

require('../background/phone-verification-flow.js');

function createTextResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

test('HeroSMS uses only the specified preferred price when acquiring a number', async () => {
  const requestedUrls = [];
  const helpers = globalThis.MultiPageBackgroundPhoneVerification.createPhoneVerificationHelpers({
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      const parsedUrl = new URL(String(url));
      const action = parsedUrl.searchParams.get('action');

      if (action === 'getPricesExtended' || action === 'getPrices') {
        return createTextResponse({
          151: {
            dr: {
              0.025: 2181,
              0.0263: 12302,
              0.4622: 25,
            },
          },
        });
      }

      if (action === 'getNumber') {
        return createTextResponse('ACCESS_NUMBER:hero-activation-1:+819012345678');
      }

      throw new Error(`Unexpected HeroSMS action: ${action || 'empty'}`);
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    addLog: async () => {},
  });

  const activation = await helpers.requestPhoneActivation({
    phoneSmsProvider: 'hero-sms',
    heroSmsApiKey: 'test-key',
    heroSmsCountryId: 151,
    heroSmsCountryLabel: '日本 (Japan)',
    heroSmsPreferredPrice: '0.4622',
    heroSmsMinPrice: '0.46',
    heroSmsMaxPrice: '1',
  });

  assert.equal(activation.activationId, 'hero-activation-1');
  const acquireUrl = requestedUrls
    .map((url) => new URL(url))
    .find((url) => url.searchParams.get('action') === 'getNumber');

  assert.ok(acquireUrl);
  assert.equal(acquireUrl.searchParams.get('service'), 'dr');
  assert.equal(acquireUrl.searchParams.get('country'), '151');
  assert.equal(acquireUrl.searchParams.get('maxPrice'), '0.4622');
  assert.equal(acquireUrl.searchParams.get('fixedPrice'), 'true');
});

test('HeroSMS acquisition uses stocked web offer tiers and skips zero-stock floor', async () => {
  const requestedUrls = [];
  const helpers = globalThis.MultiPageBackgroundPhoneVerification.createPhoneVerificationHelpers({
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      const parsedUrl = new URL(String(url));
      const action = parsedUrl.searchParams.get('action');

      if (String(url).includes('/left-menu/service/dr/country/73/offers')) {
        return createTextResponse({
          operators: [
            {
              freePriceOffers: {
                0.045: 0,
                0.0462: 350,
                0.05: 774,
              },
            },
          ],
        });
      }

      if (action === 'getPricesExtended' || action === 'getPrices') {
        return createTextResponse({
          73: {
            dr: {
              0.045: 0,
            },
          },
        });
      }

      if (action === 'getNumber') {
        assert.equal(parsedUrl.searchParams.get('maxPrice'), '0.0462');
        return createTextResponse('ACCESS_NUMBER:hero-activation-2:+559999999999');
      }

      throw new Error(`Unexpected HeroSMS action: ${action || 'empty'}`);
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    addLog: async () => {},
  });

  const activation = await helpers.requestPhoneActivation({
    phoneSmsProvider: 'hero-sms',
    heroSmsApiKey: 'test-key',
    heroSmsCountryId: 73,
    heroSmsCountryLabel: '巴西',
    heroSmsMinPrice: '0.04',
    heroSmsMaxPrice: '0.05',
  });

  assert.equal(activation.activationId, 'hero-activation-2');
  const acquireUrl = requestedUrls
    .map((url) => new URL(url))
    .find((url) => url.searchParams.get('action') === 'getNumber');

  assert.ok(acquireUrl);
  assert.equal(acquireUrl.searchParams.get('country'), '73');
  assert.equal(acquireUrl.searchParams.get('maxPrice'), '0.0462');
});
