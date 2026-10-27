import { useState, type InputHTMLAttributes } from 'react';

/** 密钥/令牌输入框：默认圆点显示，点右侧“显示”临时查看，避免旁人看到。 */
export function SecretInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="secret-input">
      <input autoComplete="new-password" spellCheck={false} autoCapitalize="off" {...props} type={visible ? 'text' : 'password'} />
      <button type="button" aria-pressed={visible} aria-label={visible ? '隐藏内容' : '显示内容'} onClick={() => setVisible((v) => !v)}>{visible ? '隐藏' : '显示'}</button>
    </span>
  );
}
