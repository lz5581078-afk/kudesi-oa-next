import { afterEach, expect, it } from 'vitest';
import { clearLiveRoom, consumeLiveRoom, liveScanCompany, rememberLiveRoom } from './liveRoomIntent';

afterEach(() => {
  clearLiveRoom();
  window.history.replaceState({}, '', '/');
});

it('扫码登录后回到指定话术版本与视频区，沿用普通登录', () => {
  const target = '/features/live?tab=scripts&upload=17&section=video';
  window.history.replaceState({}, '', target);
  rememberLiveRoom();
  expect(liveScanCompany('Lark')).toBeNull();
  window.history.replaceState({}, '', '/login');
  expect(consumeLiveRoom()).toBe(target);
});

it('未知素材分区不能作为登录回跳目标', () => {
  window.history.replaceState({}, '', '/features/live?tab=scripts&upload=17&section=bad');
  rememberLiveRoom();
  expect(consumeLiveRoom()).toBe('/');
});
