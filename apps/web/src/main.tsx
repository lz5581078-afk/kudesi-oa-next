import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import './styles.css';
import './layout/module-panel.css';
import './pages/finance/finance-data-pages.css';

// 数据路由（createBrowserRouter）：只为了能用 useBlocker——表格编辑有没保存的修改时拦截站内跳转、后退前进。
// 整个应用仍由 App 里的 <Routes> 分派页面，所以这里只有一条匹配所有地址的路由。
const router = createBrowserRouter([
  { path: '*', element: <AuthProvider><App /></AuthProvider> },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
