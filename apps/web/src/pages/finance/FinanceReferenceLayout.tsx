import { createContext, useContext, type ReactNode } from 'react';
const FinanceReference = createContext(false);
/** 弹窗继承页面的呈现方式，避免其他资料页的统一UI覆盖24号财务布局。 */
export const useFinanceReference = () => useContext(FinanceReference);
export function FinanceReferenceLayout({children}: {children:ReactNode}) {
  return <FinanceReference.Provider value={true}><div className="finance-reference">{children}</div></FinanceReference.Provider>;
}
