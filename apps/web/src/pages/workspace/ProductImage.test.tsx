import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it} from 'vitest';
import {aliasCrop, ProductImage} from './ProductImage';
afterEach(cleanup);
it.each([[1200,800],[600,1200],[800,800]])('裁剪 %s×%s 图片时保持比例，边界内取不同区域', (width,height)=>{
  const left=aliasCrop(width,height,'0% 0%'),right=aliasCrop(width,height,'100% 100%');
  expect(left.width/left.height).toBeCloseTo(width/height);
  expect(right.x+right.width).toBeCloseTo(width);
  expect(right.y+right.height).toBeCloseTo(height);
  expect(right.x).toBeGreaterThan(left.x);
  expect(right.y).toBeGreaterThan(left.y);
});
it('先裁剪再等比适配框，详情复用同一区域，换图期间不闪现原图',()=>{
  const photo={url:'/photo-a.jpg',name:'马甲图'};
  const view=render(<ProductImage photo={photo} cropPosition="80% 20%"/>);
  const load=()=>{const img=view.container.querySelector('img')!;Object.defineProperties(img,{naturalWidth:{value:600},naturalHeight:{value:1200}});fireEvent.load(img);};
  expect(view.container.querySelector('img')!.style.opacity).toBe('0');
  load();
  const outer=screen.getByRole('img');
  expect(outer.tagName.toLowerCase()).toBe('svg');
  expect(outer.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
  expect(outer.querySelector('svg')!.getAttribute('overflow')).toBe('hidden');
  const crop=aliasCrop(600,1200,'80% 20%');
  expect(outer.getAttribute('viewBox')).toBe(`0 0 ${crop.width} ${crop.height}`);
  expect(outer.querySelector('image')!.getAttribute('x')).toBe(String(-crop.x));
  expect(outer.closest('a')).toBeNull();
  view.rerender(<ProductImage photo={{...photo,url:'/photo-b.jpg'}} cropPosition="80% 20%"/>);
  expect(view.container.querySelector('svg')).toBeNull();
  expect(view.container.querySelector('img')!.style.opacity).toBe('0');
  fireEvent.error(view.container.querySelector('img')!);
  expect(screen.getByText('暂无图片')).toBeTruthy();
});
it('普通商品保持完整等比图片，不启用马甲裁剪',()=>{
  render(<ProductImage photo={{url:'/normal.jpg',name:'普通商品'}}/>);
  expect(screen.getByRole('img').tagName).toBe('IMG');
  expect(screen.getByRole('img').style.opacity).toBe('');
});
