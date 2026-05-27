(function attachBackgroundPanelBridge(root, factory) {
  root.MultiPageBackgroundPanelBridge = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundPanelBridgeModule() {
  function createPanelBridge(deps = {}) {
    const {
      chrome,
      addLog,
      createLocalCliProxyApi = null,
      closeConflictingTabsForSource,
      createAutomationTab = null,
      ensureContentScriptReadyOnTab,
      getPanelMode,
      normalizeAetherUrl,
      normalizeCodex2ApiUrl,
      normalizeSub2ApiUrl,
      rememberSourceLastUrl,
      sendToContentScript,
      sendToContentScriptResilient,
      waitForTabUrlFamily,
      DEFAULT_SUB2API_GROUP_NAME,
      SUB2API_STEP1_RESPONSE_TIMEOUT_MS,
    } = deps;

    let sub2ApiApi = null;
    let localCliProxyApi = null;

    function getSub2ApiApi() {
      if (sub2ApiApi) {
        return sub2ApiApi;
      }
      const factory = deps.createSub2ApiApi
        || self.MultiPageBackgroundSub2ApiApi?.createSub2ApiApi;
      if (typeof factory !== 'function') {
        throw new Error('SUB2API 直连接口模块未加载，无法生成 OAuth 链接。');
      }
      sub2ApiApi = factory({
        addLog,
        normalizeSub2ApiUrl,
        DEFAULT_SUB2API_GROUP_NAME,
      });
      return sub2ApiApi;
    }

    function normalizeAdminKey(value = '') {
      return String(value || '').trim();
    }

    function getLocalCliProxyApi() {
      if (localCliProxyApi) {
        return localCliProxyApi;
      }
      const factory = createLocalCliProxyApi
        || self.MultiPageBackgroundLocalCliProxyApi?.createLocalCliProxyApi;
      if (typeof factory !== 'function') {
        throw new Error('本地 CPA JSON 有RT 模块未加载，无法生成 OAuth 链接。');
      }
      localCliProxyApi = factory({
        crypto: globalThis.crypto,
        fetch: typeof fetch === 'function' ? fetch.bind(globalThis) : null,
        sessionToJsonConverter: self.MultiPageSessionToJsonConverter,
      });
      return localCliProxyApi;
    }

    function extractStateFromAuthUrl(authUrl = '') {
      try {
        return new URL(authUrl).searchParams.get('state') || '';
      } catch {
        return '';
      }
    }

    function getCodex2ApiErrorMessage(payload, responseStatus = 500) {
      const candidates = [
        payload?.error,
        payload?.message,
        payload?.detail,
        payload?.reason,
      ];
      const message = candidates
        .map((value) => String(value || '').trim())
        .find(Boolean);
      return message || `Codex2API 请求失败（HTTP ${responseStatus}）。`;
    }

    function getAetherApiErrorMessage(payload, responseStatus = 500) {
      const candidates = [
        payload?.detail,
        payload?.error,
        payload?.message,
        payload?.reason,
      ];
      const message = candidates
        .map((value) => String(value || '').trim())
        .find(Boolean);
      return message || `Aether 请求失败（HTTP ${responseStatus}）。`;
    }

    function normalizeAetherProviderId(value = '', aetherUrl = '') {
      const direct = String(value || '').trim();
      if (direct) {
        return direct;
      }
      try {
        const fromUrl = new URL(aetherUrl).searchParams.get('providerId');
        if (fromUrl) {
          return fromUrl.trim();
        }
      } catch {
        // Fall back to the built-in default below.
      }
      return '20641f07-caa0-4988-b7ff-adac2383b73f';
    }

    function getAetherBearerToken(state = {}) {
      return String(state?.aetherBearerToken || '').trim();
    }

    function getAetherDeviceId(state = {}) {
      return String(state?.aetherDeviceId || '').trim();
    }

    async function runAetherApiWithBearer(origin, path, options = {}) {
      const token = String(options.bearerToken || '').trim();
      const deviceId = String(options.deviceId || '').trim();
      if (!token || !deviceId) {
        return null;
      }
      const response = await fetch(`${origin}${path}`, {
        method: options.method || 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Client-Device-Id': deviceId,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }
      return { ok: response.ok, status: response.status, payload };
    }

    async function getAetherAutomationTab(origin, options = {}) {
      const poolUrl = options.poolUrl || `${origin}/admin/pool`;
      const queryPattern = `${origin.replace(/\/+$/, '')}/*`;
      let tabs = [];
      try {
        tabs = await chrome.tabs.query({ url: queryPattern });
      } catch {
        tabs = [];
      }
      const poolTabs = tabs.filter((tab) => /\/admin\/pool(?:[?#]|$)/i.test(String(tab?.url || '')));
      if (poolTabs.length) {
        return poolTabs.find((tab) => tab.active) || poolTabs[0];
      }
      if (tabs.length) {
        return tabs.find((tab) => tab.active) || tabs[0];
      }
      if (!tabs.length && typeof createAutomationTab === 'function') {
        try {
          const created = await createAutomationTab({ url: poolUrl, active: true });
          if (created?.id) {
            await new Promise((resolve) => setTimeout(resolve, 1200));
            return created;
          }
        } catch {
          return null;
        }
      }
      return null;
    }

    async function runAetherApiFromPage(origin, path, options = {}) {
      if (!chrome?.tabs?.query || !chrome?.scripting?.executeScript) {
        throw new Error('当前浏览器不支持读取 Aether 页面登录态。');
      }
      const tab = await getAetherAutomationTab(origin, options);
      if (!tab?.id) {
        throw new Error('未找到 Aether 页面，请先打开并登录 Aether 号池页后重试。');
      }
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async ({ requestPath, requestMethod, requestBody }) => {
          function getDeviceId() {
            const existing = localStorage.getItem('aether_client_device_id') || '';
            if (existing) return existing;
            const created = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `device-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
            localStorage.setItem('aether_client_device_id', created);
            return created;
          }

          async function requestWithToken(token) {
            const deviceId = getDeviceId();
            const response = await fetch(requestPath, {
              method: requestMethod,
              credentials: 'include',
              headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(deviceId ? { 'X-Client-Device-Id': deviceId } : {}),
              },
              body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
            });
            let payload = {};
            try {
              payload = await response.json();
            } catch {
              payload = {};
            }
            return { ok: response.ok, status: response.status, payload };
          }

          let token = localStorage.getItem('access_token') || '';
          let result = await requestWithToken(token);
          if (result.status === 401) {
            try {
              const refreshResponse = await fetch('/api/auth/refresh', {
                method: 'POST',
                credentials: 'include',
                headers: {
                  Accept: 'application/json',
                  'Content-Type': 'application/json',
                },
                body: '{}',
              });
              const refreshPayload = await refreshResponse.json().catch(() => ({}));
              token = refreshPayload?.access_token || '';
              if (refreshResponse.ok && token) {
                localStorage.setItem('access_token', token);
                result = await requestWithToken(token);
              }
            } catch {
              // Keep the original 401 result.
            }
          }
          return result;
        },
        args: [{
          requestPath: path,
          requestMethod: options.method || 'POST',
          requestBody: options.body,
        }],
      });
      if (!result || typeof result !== 'object') {
        throw new Error('Aether 页面未返回接口结果，请确认页面已正常加载。');
      }
      return result;
    }

    async function fetchAetherJson(origin, path, options = {}) {
      const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || 30000));
      let timeoutHandle = null;
      try {
        const result = await Promise.race([
          runAetherApiWithBearer(origin, path, options).then((result) => {
            if (!result || result.status === 401 || result.status === 403) {
              return runAetherApiFromPage(origin, path, options);
            }
            return result;
          }),
          new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error('Aether 请求超时，请稍后重试。')), timeoutMs);
          }),
        ]);

        if (!result.ok) {
          throw new Error(getAetherApiErrorMessage(result.payload, result.status));
        }
        return result.payload || {};
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    function deriveCpaManagementOrigin(vpsUrl) {
      const normalizedUrl = String(vpsUrl || '').trim();
      if (!normalizedUrl) {
        throw new Error('尚未配置 CPA 地址，请先在侧边栏填写。');
      }
      let parsed;
      try {
        parsed = new URL(normalizedUrl);
      } catch {
        throw new Error('CPA 地址格式无效，请先在侧边栏检查。');
      }
      return parsed.origin;
    }

    function getCpaApiErrorMessage(payload, responseStatus = 500) {
      const candidates = [
        payload?.error,
        payload?.message,
        payload?.detail,
        payload?.reason,
      ];
      const message = candidates
        .map((value) => String(value || '').trim())
        .find(Boolean);
      return message || `CPA 管理接口请求失败（HTTP ${responseStatus}）。`;
    }

    async function fetchCpaManagementJson(origin, path, options = {}) {
      const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || 20000));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const managementKey = String(options.managementKey || '').trim();
        const headers = {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        };
        if (managementKey) {
          headers.Authorization = `Bearer ${managementKey}`;
          headers['X-Management-Key'] = managementKey;
        }

        const response = await fetch(`${origin}${path}`, {
          method: options.method || 'POST',
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });

        let payload = {};
        try {
          payload = await response.json();
        } catch {
          payload = {};
        }

        if (!response.ok) {
          throw new Error(getCpaApiErrorMessage(payload, response.status));
        }

        return payload;
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error('CPA 管理接口请求超时，请稍后重试。');
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    async function fetchCodex2ApiJson(origin, path, options = {}) {
      const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || 30000));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${origin}${path}`, {
          method: options.method || 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Admin-Key': normalizeAdminKey(options.adminKey),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });

        let payload = {};
        try {
          payload = await response.json();
        } catch {
          payload = {};
        }

        if (!response.ok) {
          throw new Error(getCodex2ApiErrorMessage(payload, response.status));
        }

        return payload;
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error('Codex2API 请求超时，请稍后重试。');
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    async function requestOAuthUrlFromPanel(state, options = {}) {
      if (getPanelMode(state) === 'local-cpa-json') {
        return requestLocalCpaJsonOAuthUrl(state, options);
      }
      if (getPanelMode(state) === 'codex2api') {
        return requestCodex2ApiOAuthUrl(state, options);
      }
      if (getPanelMode(state) === 'aether') {
        return requestAetherOAuthUrl(state, options);
      }
      if (getPanelMode(state) === 'sub2api') {
        return requestSub2ApiOAuthUrl(state, options);
      }
      return requestCpaOAuthUrl(state, options);
    }

    async function requestCpaOAuthUrl(state, options = {}) {
      const { logLabel = 'OAuth 刷新' } = options;
      if (!state.vpsUrl) {
        throw new Error('尚未配置 CPA 地址，请先在侧边栏填写。');
      }
      const managementKey = String(state.vpsPassword || '').trim();
      if (!managementKey) {
        throw new Error('尚未配置 CPA 管理密钥，请先在侧边栏填写。');
      }

      const origin = deriveCpaManagementOrigin(state.vpsUrl);

      await addLog(`${logLabel}：正在通过 CPA 管理接口获取 OAuth 授权链接...`);
      const result = await fetchCpaManagementJson(origin, '/v0/management/codex-auth-url', {
        method: 'GET',
        managementKey,
      });

      const oauthUrl = String(
        result?.url
        || result?.auth_url
        || result?.authUrl
        || result?.data?.url
        || result?.data?.auth_url
        || result?.data?.authUrl
        || ''
      ).trim();
      const oauthState = String(
        result?.state
        || result?.auth_state
        || result?.authState
        || result?.data?.state
        || result?.data?.auth_state
        || result?.data?.authState
        || ''
      ).trim()
        || extractStateFromAuthUrl(oauthUrl);

      if (!oauthUrl || !oauthUrl.startsWith('http')) {
        throw new Error('CPA 管理接口未返回有效的 auth_url。');
      }

      return {
        oauthUrl,
        cpaOAuthState: oauthState || null,
        cpaManagementOrigin: origin,
      };
    }

    async function requestLocalCpaJsonOAuthUrl(state, options = {}) {
      const { logLabel = 'OAuth 刷新' } = options;
      if (!String(state?.localCpaJsonPluginDir || '').trim()) {
        throw new Error('尚未配置本地插件目录，请先在侧边栏填写。');
      }

      await addLog(`${logLabel}：正在按本地 CPA JSON 有RT 规则生成 OAuth 授权链接...`);
      const api = getLocalCliProxyApi();
      const result = await api.createAuthorizationRequest();

      return {
        oauthUrl: result.oauthUrl,
        localCpaJsonOAuthState: result.oauthState || null,
        localCpaJsonPkceCodes: result.pkceCodes || null,
      };
    }

    async function requestCodex2ApiOAuthUrl(state, options = {}) {
      const { logLabel = 'OAuth 刷新' } = options;
      const codex2apiUrl = normalizeCodex2ApiUrl(state.codex2apiUrl);
      const adminKey = normalizeAdminKey(state.codex2apiAdminKey);

      if (!adminKey) {
        throw new Error('尚未配置 Codex2API 管理密钥，请先在侧边栏填写。');
      }

      const origin = new URL(codex2apiUrl).origin;
      await addLog(`${logLabel}：正在通过 Codex2API 协议生成 OAuth 授权链接...`);

      const result = await fetchCodex2ApiJson(origin, '/api/admin/oauth/generate-auth-url', {
        adminKey,
        method: 'POST',
        body: {},
      });

      const oauthUrl = String(result?.auth_url || result?.authUrl || '').trim();
      const sessionId = String(result?.session_id || result?.sessionId || '').trim();
      const oauthState = extractStateFromAuthUrl(oauthUrl);

      if (!oauthUrl || !sessionId) {
        throw new Error('Codex2API 未返回有效的 auth_url 或 session_id。');
      }

      return {
        oauthUrl,
        codex2apiSessionId: sessionId,
        codex2apiOAuthState: oauthState || null,
      };
    }

    async function requestAetherOAuthUrl(state, options = {}) {
      const { logLabel = 'OAuth 刷新' } = options;
      const aetherUrl = normalizeAetherUrl(state.aetherUrl);
      const providerId = normalizeAetherProviderId(state.aetherProviderId, aetherUrl);
      const parsed = new URL(aetherUrl);
      const origin = parsed.origin;
      const poolUrl = `${origin}/admin/pool?providerId=${encodeURIComponent(providerId)}`;

      await addLog(`${logLabel}：正在通过 Aether 生成 OAuth 授权链接...`);
      const result = await fetchAetherJson(origin, `/api/admin/provider-oauth/providers/${encodeURIComponent(providerId)}/start`, {
        method: 'POST',
        body: {},
        poolUrl,
        bearerToken: getAetherBearerToken(state),
        deviceId: getAetherDeviceId(state),
      });

      const oauthUrl = String(result?.authorization_url || result?.auth_url || result?.authUrl || '').trim();
      const oauthState = extractStateFromAuthUrl(oauthUrl);
      if (!oauthUrl || !oauthUrl.startsWith('http')) {
        throw new Error('Aether 未返回有效的 authorization_url。');
      }

      return {
        oauthUrl,
        aetherOAuthState: oauthState || null,
      };
    }

    async function requestSub2ApiOAuthUrl(state, options = {}) {
      const { logLabel = 'OAuth 刷新' } = options;
      const sub2apiUrl = normalizeSub2ApiUrl(state.sub2apiUrl);

      if (!sub2apiUrl) {
        throw new Error('SUB2API URL is not configured. Please fill it in the side panel first.');
      }
      if (!state.sub2apiEmail) {
        throw new Error('尚未配置 SUB2API 登录邮箱，请先在侧边栏填写。');
      }
      if (!state.sub2apiPassword) {
        throw new Error('尚未配置 SUB2API 登录密码，请先在侧边栏填写。');
      }

      const api = getSub2ApiApi();
      return api.generateOpenAiAuthUrl({
        ...state,
          sub2apiUrl,
      }, {
        logLabel,
        timeoutMs: SUB2API_STEP1_RESPONSE_TIMEOUT_MS,
      });
    }

    return {
      requestOAuthUrlFromPanel,
      requestLocalCpaJsonOAuthUrl,
      requestCodex2ApiOAuthUrl,
      requestAetherOAuthUrl,
      requestCpaOAuthUrl,
      requestSub2ApiOAuthUrl,
    };
  }

  return {
    createPanelBridge,
  };
});
