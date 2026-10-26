import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import { menuTemplate, type MenuActions } from '../src/main/menu';

const actions: MenuActions = {
  open() {}, openRecent() {}, clearRecent() {}, command() {}, toggleMenuBar() {}, toggleBackups() {},
  recent: () => ['/x/a&b.pdf'], menuHidden: () => false, backups: () => true, canRevert: () => false,
};
const roles = (items: MenuItemConstructorOptions[]): string[] =>
  items.flatMap(i => [...(i.role ? [i.role] : []), ...roles(Array.isArray(i.submenu) ? i.submenu : [])]);

describe('menuTemplate', () => {
  it('has Reload only in development builds (it skips the save before closing)', () => {
    expect(roles(menuTemplate(actions, { isMac: false, dev: true }))).toContain('reload');
    expect(roles(menuTemplate(actions, { isMac: false, dev: false }))).not.toContain('reload');
    expect(roles(menuTemplate(actions, { isMac: true, dev: false }))).not.toContain('reload');
  });
  it('lists recent files with escaped ampersands', () => {
    const file = menuTemplate(actions, { isMac: false, dev: false })[0].submenu as MenuItemConstructorOptions[];
    const recent = file.find(i => i.label === 'Open &Recent')!.submenu as MenuItemConstructorOptions[];
    expect(recent[0].label).toBe('&1 a&&b.pdf');
  });
  it('has Revert to Backup, enabled when there is one, and the Keep a Backup checkbox', () => {
    let on = false, revert = false, toggled = 0;
    const commands: string[] = [];
    const a = { ...actions, backups: () => on, canRevert: () => revert, toggleBackups: () => { toggled++; }, command: (c: string) => { commands.push(c); } };
    const file = () => menuTemplate(a as MenuActions, { isMac: false, dev: false })[0].submenu as MenuItemConstructorOptions[];
    const item = (label: string) => file().find(i => i.label === label)!;
    expect(item('Keep a &Backup of the Notes').type).toBe('checkbox');
    expect(item('Keep a &Backup of the Notes').checked).toBe(false);
    expect(item('Re&vert to Backup…').enabled).toBe(false);
    on = revert = true;
    expect(item('Keep a &Backup of the Notes').checked).toBe(true);
    expect(item('Re&vert to Backup…').enabled).toBe(true);
    (item('Keep a &Backup of the Notes').click as () => void)();
    (item('Re&vert to Backup…').click as () => void)();
    expect(toggled).toBe(1);
    expect(commands).toEqual(['revert-backup']);
  });
});
