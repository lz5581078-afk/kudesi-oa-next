import { Link } from 'react-router-dom';

export function NoAccessPage() {
  return (
    <div className="empty-state">
      <h1>没有访问权限</h1>
      <p>你的岗位没有开通这个页面。需要的话，请联系公司管理员。</p>
      <Link to="/">回到首页</Link>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="empty-state">
      <h1>页面不存在或尚未开放</h1>
      <Link to="/">回到首页</Link>
    </div>
  );
}
