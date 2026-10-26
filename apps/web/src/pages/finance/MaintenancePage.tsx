import { makeSessionApi } from './sessionApi';
import { Shops } from './StoreWithdrawalPage';

const client = makeSessionApi('/store-maintenance');

/** 公司店铺维护：维护公司店铺的独立登录环境（授权电脑由“店铺提现”页的“授权电脑”统一绑定），并可以直接改店铺档案状态。 */
export function MaintenancePage() {
  return (
    <div>
      <div className="page-head"><h1>管理公司店铺维护</h1></div>
      <p className="muted">这里的店铺清单和“店铺提现”互相独立。可以添加任何状态的店铺，点“首次登录/立即登录”让授权电脑上的助手打开店铺后台，也可以直接改店铺档案状态（改成异常要从店铺档案的异常原因库里选原因）。</p>
      <Shops client={client} maintenance />
    </div>
  );
}
