import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Link, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { FeishuBindingReminder } from './FeishuBindingReminder';
const state={user:{feishuBindingPending:true}};
vi.mock('./AuthContext',()=>({useAuth:()=>state}));
afterEach(()=>{cleanup();state.user.feishuBindingPending=true;});
it('未绑定提醒跨页面持续显示，不能被稍后关闭，绑定后立即消失',()=>{
 const view=render(<MemoryRouter><FeishuBindingReminder/><Link to="/account/password">修改密码</Link><Link to="/features/live-desk">扫码页面</Link><Routes><Route path="*" element={<div/>}/></Routes></MemoryRouter>);
 expect(screen.getByRole('complementary',{name:'飞书绑定提醒'})).toBeTruthy();
 for(const name of ['修改密码','扫码页面']){fireEvent.click(screen.getByRole('link',{name}));expect(screen.getByRole('link',{name:'去绑定'})).toBeTruthy();}
 expect(screen.queryByRole('button',{name:/稍后/})).toBeNull();
 state.user.feishuBindingPending=false;view.rerender(<MemoryRouter><FeishuBindingReminder/></MemoryRouter>);
 expect(screen.queryByRole('complementary')).toBeNull();
});
