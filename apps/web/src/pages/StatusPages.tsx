import { Link, useLocation, useNavigate } from 'react-router-dom';

function Back() {
  const navigate = useNavigate();
  return <div className="row-actions"><button type="button" className="secondary-button" onClick={() => navigate(-1)}>返回上一页</button><Link to="/">回到首页</Link></div>;
}

export function NoAccessPage() {
  return (
    <div className="empty-state">
      <h1>没有访问权限</h1>
      <p>你的岗位没有开通这个页面。需要的话，请联系公司管理员在“员工与岗位”里为你的岗位开通。</p>
      <Back />
    </div>
  );
}

export function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <div className="empty-state">
      <h1>页面不存在或尚未开放</h1>
      <p className="muted mono">{pathname}</p>
      <p>地址可能输错了，或这个功能还在准备中。可以用顶部的搜索（Ctrl/⌘+K）找功能。</p>
      <Back />
    </div>
  );
}
