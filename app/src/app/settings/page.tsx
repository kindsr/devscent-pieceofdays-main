import { FontSettings } from "@/ui/d/FontSettings";

export default function SettingsPage() {
  return (
    <>
      <header className="board-head">
        <h1 tabIndex={-1}>설정</h1>
        <p className="sub">나에게 맞게</p>
      </header>
      <FontSettings />
    </>
  );
}
