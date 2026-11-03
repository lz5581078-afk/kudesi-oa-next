const ALLOWED_NAMED_KEYS = new Set([
  'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'Backspace', 'Delete',
  'End', 'Enter', 'Escape', 'Home', 'PageDown', 'PageUp', 'Space', 'Tab'
]);
const FORBIDDEN_KEY_PARTS = new Set(['Alt', 'Control', 'Meta', 'OS']);
const { getPlatformAdapter } = require('./platforms');

class RemoteInputError extends Error {
  constructor(message, { fatal = false, reason = 'command_rejected' } = {}) {
    super(message);
    this.name = 'RemoteInputError';
    this.fatal = Boolean(fatal);
    this.reason = String(reason || 'command_rejected');
  }
}

function inputError(message, options) {
  return new RemoteInputError(message, options);
}

function isAllowedPlatformUrl(platformCode, value) {
  try { return getPlatformAdapter(platformCode).ownsUrl(value); }
  catch { return false; }
}

function isAllowedPddUrl(value) {
  return isAllowedPlatformUrl('pdd', value);
}

function mapCapturePointToPage(input) {
  const numbers = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Number(value)]));
  const required = [
    'captureWidth', 'captureHeight', 'outerWidth', 'outerHeight',
    'innerWidth', 'innerHeight', 'x', 'y'
  ];
  if (required.some((key) => !Number.isFinite(numbers[key])) ||
      numbers.captureWidth <= 0 || numbers.captureHeight <= 0 ||
      numbers.outerWidth <= 0 || numbers.outerHeight <= 0 ||
      numbers.innerWidth <= 0 || numbers.innerHeight <= 0) {
    throw inputError('远程画面尺寸无效', { reason: 'invalid_dimensions' });
  }

  const scaleX = numbers.captureWidth / numbers.outerWidth;
  const scaleY = numbers.captureHeight / numbers.outerHeight;
  const horizontalInset = Math.max(0, (numbers.outerWidth - numbers.innerWidth) / 2);
  const topInset = Math.max(0, numbers.outerHeight - numbers.innerHeight - horizontalInset);
  const cssX = numbers.x / scaleX;
  const cssY = numbers.y / scaleY;
  const pageX = cssX - horizontalInset;
  const pageY = cssY - topInset;
  if (pageX < 0 || pageY < 0 || pageX >= numbers.innerWidth || pageY >= numbers.innerHeight) {
    throw inputError('操作坐标不在店铺网页内容区', { reason: 'outside_content' });
  }
  return { x: Math.round(pageX), y: Math.round(pageY) };
}

function mapCapturePointToBrowserTab(input, pageCount) {
  const numbers = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Number(value)]));
  const required = [
    'captureWidth', 'captureHeight', 'outerWidth', 'outerHeight',
    'innerWidth', 'innerHeight', 'x', 'y'
  ];
  if (required.some((key) => !Number.isFinite(numbers[key])) ||
      numbers.captureWidth <= 0 || numbers.captureHeight <= 0 ||
      numbers.outerWidth <= 0 || numbers.outerHeight <= 0 ||
      numbers.innerWidth <= 0 || numbers.innerHeight <= 0 ||
      !Number.isInteger(pageCount) || pageCount <= 0) {
    throw inputError('远程画面尺寸无效', { reason: 'invalid_dimensions' });
  }

  const scaleX = numbers.captureWidth / numbers.outerWidth;
  const scaleY = numbers.captureHeight / numbers.outerHeight;
  const cssX = numbers.x / scaleX;
  const cssY = numbers.y / scaleY;
  const tabStripHeight = Math.min(56, Math.max(36,
    numbers.outerHeight - numbers.innerHeight - Math.max(0, (numbers.outerWidth - numbers.innerWidth) / 2)));
  if (cssY < 0 || cssY >= tabStripHeight) {
    throw inputError('浏览器工具栏不在允许操作范围', { reason: 'browser_toolbar_forbidden' });
  }

  const tabStripStart = 36;
  const protectedWindowControlsWidth = 176;
  const tabStripEnd = numbers.outerWidth - protectedWindowControlsWidth;
  if (cssX >= tabStripEnd) {
    throw inputError('远程操作不允许使用浏览器窗口按钮', { reason: 'protected_system_control' });
  }
  if (cssX < tabStripStart) {
    throw inputError('浏览器菜单不在允许操作范围', { reason: 'browser_toolbar_forbidden' });
  }

  const tabWidth = Math.min(240, Math.max(48, (tabStripEnd - tabStripStart) / pageCount));
  const tabIndex = Math.floor((cssX - tabStripStart) / tabWidth);
  if (tabIndex < 0 || tabIndex >= pageCount) {
    throw inputError('新建标签页不在允许操作范围', { reason: 'browser_toolbar_forbidden' });
  }
  const offsetInTab = cssX - (tabStripStart + tabIndex * tabWidth);
  return { tabIndex, close: offsetInTab >= tabWidth - 32 };
}

function createRemoteInputRegistry() {
  const targets = new Map();

  async function pageDimensions(target, page, command = {}) {
    const captureWidth = Number(command.captureWidth || 0);
    const captureHeight = Number(command.captureHeight || 0);
    const windowVersion = String(command.windowVersion || 'default');
    const key = captureWidth > 0 && captureHeight > 0
      ? `${captureWidth}x${captureHeight}:${windowVersion}`
      : `default:${windowVersion}`;
    const current = target.pageDimensions.get(page);
    if (current?.key === key) return current.value;
    const value = await page.evaluate(() => ({
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight
    }));
    target.pageDimensions.set(page, { key, value });
    return value;
  }

  function merchantPages(target) {
    const pages = target.context?.pages?.() || [target.page];
    return pages.filter((page) => page && !page.isClosed?.() &&
      isAllowedPlatformUrl(target.platformCode, page.url?.()));
  }

  function currentPage(target) {
    if (target.page && !target.page.isClosed?.()) return target.page;
    const page = merchantPages(target).at(-1);
    if (page) target.page = page;
    return page;
  }

  async function waitForPagePaint(page) {
    if (!page?.evaluate) return;
    try {
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80)));
      }));
    } catch {
      // A closing or navigating page can disappear while the next tab is activated.
    }
  }

  async function activatePage(target, page) {
    if (!page?.bringToFront) return;
    const operation = async () => {
      await page.bringToFront();
      await waitForPagePaint(page);
    };
    if (typeof target.foregroundGuard === 'function') {
      await target.foregroundGuard(operation);
      return;
    }
    await operation();
  }

  async function refreshActivePage(target, previousPage) {
    target.pageDimensions = new WeakMap();
    const deadline = Date.now() + 500;
    do {
      const pages = merchantPages(target);
      for (const candidate of pages) {
        try {
          if (await candidate.evaluate(() => document.visibilityState === 'visible')) {
            target.page = candidate;
            return candidate;
          }
        } catch { }
      }
      if (previousPage?.isClosed?.()) {
        const remaining = pages.at(-1);
        if (remaining) {
          target.page = remaining;
          return remaining;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return currentPage(target);
  }

  async function switchTab(target, direction) {
    const pages = merchantPages(target);
    if (!pages.length) throw inputError('浏览器窗口不存在', { fatal: true, reason: 'target_closed' });
    const active = currentPage(target);
    const currentIndex = Math.max(0, pages.indexOf(active));
    const nextIndex = direction === 'latest'
      ? pages.length - 1
      : (currentIndex + (direction === 'previous' ? -1 : 1) + pages.length) % pages.length;
    target.page = pages[nextIndex];
    await activatePage(target, target.page);
  }

  async function closeCurrentTab(target) {
    const pages = merchantPages(target);
    if (pages.length <= 1) throw inputError('不能关闭最后一个商家标签页', { reason: 'last_tab' });
    const active = currentPage(target);
    const currentIndex = Math.max(0, pages.indexOf(active));
    await active.close({ runBeforeUnload: false });
    const remaining = merchantPages(target);
    target.page = remaining[Math.min(currentIndex, remaining.length - 1)];
    await activatePage(target, target.page);
  }

  async function handleBrowserTabClick(target, command, dimensions) {
    if (command.type !== 'click') {
      throw inputError('浏览器标签栏只允许单击操作', { reason: 'browser_toolbar_forbidden' });
    }
    const pages = merchantPages(target);
    if (!pages.length) throw inputError('浏览器窗口不存在', { fatal: true, reason: 'target_closed' });
    const action = mapCapturePointToBrowserTab({ ...dimensions, ...command }, pages.length);
    const selected = pages[action.tabIndex];
    if (!selected) throw inputError('目标标签页不存在', { reason: 'target_closed' });
    if (action.close) {
      if (pages.length <= 1) throw inputError('不能关闭最后一个商家标签页', { reason: 'last_tab' });
      await selected.close({ runBeforeUnload: false });
      const remaining = merchantPages(target);
      target.page = remaining[Math.min(action.tabIndex, remaining.length - 1)];
    } else {
      target.page = selected;
    }
    target.pageDimensions = new WeakMap();
    await activatePage(target, target.page);
  }

  function targetForBinding(binding) {
    const browserSessionId = String(binding?.browserSessionId || '');
    const target = targets.get(browserSessionId);
    if (!target ||
        !binding?.remoteSessionId ||
        target.localProfileId !== String(binding.localProfileId || '') ||
        target.shopId !== String(binding.shopId || '') ||
        target.deviceId !== String(binding.deviceId || '')) {
      throw inputError('远程输入目标归属不一致', { fatal: true, reason: 'ownership_mismatch' });
    }
    if (binding.platformCode && target.platformCode !== String(binding.platformCode)) {
      throw inputError('远程输入平台归属不一致', { fatal: true, reason: 'platform_mismatch' });
    }
    return target;
  }

  return {
    register({ browserSessionId, localProfileId, shopId, deviceId, platformCode, page, context }) {
      const id = String(browserSessionId || '');
      const profileId = String(localProfileId || '');
      const normalizedShopId = String(shopId || '');
      const normalizedDeviceId = String(deviceId || '');
      const normalizedPlatformCode = String(platformCode || '');
      if (!id || !profileId || !normalizedShopId || !normalizedDeviceId || !normalizedPlatformCode || !page) {
        throw inputError('远程输入目标无效', { fatal: true, reason: 'invalid_target' });
      }
      if (targets.has(id)) throw inputError('browserSessionId已注册', { fatal: true, reason: 'duplicate_target' });
      const target = {
        localProfileId: profileId,
        shopId: normalizedShopId,
        deviceId: normalizedDeviceId,
        platformCode: normalizedPlatformCode,
        page,
        context,
        foregroundGuard: null,
        pageDimensions: new WeakMap()
      };
      const promotePage = (candidate) => {
        if (candidate && !candidate.isClosed?.()) {
          target.page = candidate;
        }
      };
      const observePage = (candidate) => {
        promotePage(candidate);
        target.pageDimensions = new WeakMap();
      };
      context?.on?.('page', observePage);
      targets.set(id, target);
      return () => {
        context?.off?.('page', observePage);
        targets.delete(id);
      };
    },
    setForegroundGuard(browserSessionId, guard) {
      const target = targets.get(String(browserSessionId || ''));
      if (!target && guard === null) return;
      if (!target) throw inputError('远程输入目标不存在', { fatal: true, reason: 'target_closed' });
      if (guard !== null && typeof guard !== 'function') {
        throw inputError('前台窗口保护器无效', { fatal: true, reason: 'invalid_target' });
      }
      target.foregroundGuard = guard;
    },
    async refresh(binding) {
      const target = targetForBinding(binding);
      const page = await refreshActivePage(target, currentPage(target));
      if (!page || page.isClosed?.()) {
        throw inputError('浏览器窗口不存在', { fatal: true, reason: 'target_closed' });
      }
      if (!isAllowedPlatformUrl(target.platformCode, page.url?.())) {
        throw inputError('当前标签页不在允许操作范围', { reason: 'url_not_allowed' });
      }
      await activatePage(target, page);
      target.pageDimensions = new WeakMap();
      return page;
    },
    async dispatch(binding, command) {
      const target = targetForBinding(binding);
      if (command?.type === 'activateLatestTab') {
        await switchTab(target, 'latest');
        return;
      }
      if (command?.type === 'previousTab' || command?.type === 'nextTab') {
        await switchTab(target, command.type === 'previousTab' ? 'previous' : 'next');
        return;
      }
      if (command?.type === 'closeTab') {
        await closeCurrentTab(target);
        return;
      }
      if (['click', 'doubleClick', 'drag'].includes(command?.type)) {
        const activePage = currentPage(target);
        if (!activePage) throw inputError('浏览器窗口不存在', { fatal: true, reason: 'target_closed' });
        let browserChromeInput = false;
        if (command.type !== 'scroll') {
          const probe = command.type === 'drag' ? command.start : command;
          const dimensions = await pageDimensions(target, activePage, command);
          try { mapCapturePointToPage({ ...dimensions, ...command, ...probe }); }
          catch (error) {
            if (error instanceof RemoteInputError && error.reason === 'outside_content') browserChromeInput = true;
            else throw error;
          }
        }
        if (!browserChromeInput && !isAllowedPlatformUrl(target.platformCode, activePage.url?.())) {
          throw inputError('当前标签页不在允许操作范围', { reason: 'url_not_allowed' });
        }
        if (browserChromeInput) {
          const dimensions = await pageDimensions(target, activePage, command);
          await handleBrowserTabClick(target, command, dimensions);
          if (!isAllowedPlatformUrl(target.platformCode, target.page?.url?.())) {
            throw inputError('当前标签页不在允许操作范围', { reason: 'url_not_allowed' });
          }
          return;
        }
      }
      const page = currentPage(target);
      if (!page) throw inputError('浏览器窗口不存在', { fatal: true, reason: 'target_closed' });
      if (!isAllowedPlatformUrl(target.platformCode, page.url?.())) {
        throw inputError('页面已离开所属平台允许的商家域名', { fatal: true, reason: 'url_not_allowed' });
      }
      if (command?.type === 'click') {
        const dimensions = await pageDimensions(target, page, command);
        const point = mapCapturePointToPage({ ...dimensions, ...command });
        await page.mouse.click(point.x, point.y);
        return;
      }
      if (command?.type === 'doubleClick') {
        const dimensions = await pageDimensions(target, page, command);
        const point = mapCapturePointToPage({ ...dimensions, ...command });
        await page.mouse.click(point.x, point.y, { clickCount: 2, delay: 80 });
        return;
      }
      if (command?.type === 'drag') {
        const dimensions = await pageDimensions(target, page, command);
        const start = mapCapturePointToPage({
          ...dimensions,
          captureWidth: command.captureWidth,
          captureHeight: command.captureHeight,
          ...command.start
        });
        const end = mapCapturePointToPage({
          ...dimensions,
          captureWidth: command.captureWidth,
          captureHeight: command.captureHeight,
          ...command.end
        });
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        try {
          await page.mouse.move(end.x, end.y, { steps: 8 });
        } finally {
          await page.mouse.up();
        }
        return;
      }
      if (command?.type === 'scroll') {
        const deltaX = Number(command.deltaX || 0);
        const deltaY = Number(command.deltaY || 0);
        if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
          throw inputError('滚动参数无效', { reason: 'invalid_scroll' });
        }
        await page.mouse.wheel(deltaX, deltaY);
        return;
      }
      if (command?.type === 'key') {
        const key = String(command.key || '');
        const parts = key.split('+');
        const baseKey = parts.at(-1);
        const modifiers = parts.slice(0, -1);
        if (parts.some((part) => FORBIDDEN_KEY_PARTS.has(part)) ||
            modifiers.some((part) => part !== 'Shift') || modifiers.length > 1 ||
            (!ALLOWED_NAMED_KEYS.has(baseKey) && !/^[a-z0-9]$/i.test(baseKey))) {
          throw inputError('禁止发送该键盘按键', { reason: 'key_forbidden' });
        }
        await page.keyboard.press(key);
        return;
      }
      if (command?.type === 'text') {
        const text = String(command.text || '');
        if (!text || text.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
          throw inputError('文本输入无效', { reason: 'invalid_text' });
        }
        await page.keyboard.insertText(text);
        return;
      }
      throw inputError('未知远程输入命令', { reason: 'unknown_command' });
    }
  };
}

const defaultRemoteInputRegistry = createRemoteInputRegistry();

module.exports = {
  RemoteInputError,
  createRemoteInputRegistry,
  defaultRemoteInputRegistry,
  isAllowedPlatformUrl,
  isAllowedPddUrl,
  mapCapturePointToBrowserTab,
  mapCapturePointToPage
};
