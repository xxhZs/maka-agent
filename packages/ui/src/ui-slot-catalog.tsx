import type { ReactNode } from 'react';
import {
  type ChildrenDecl,
  type PropsRuntime,
  SlotCore,
} from './ui-slots.js';

export interface EmptySlotOwner {
  children?: never;
}

export interface FrameSlotOwner {
  collapsed: boolean;
  width: number;
}

export interface BrandMarkSlotOwner {
  size: number;
  className?: string;
}

export interface SidebarSectionSlotOwner {
  wide: boolean;
}

export interface SettingsSectionSlotOwner {
  close: () => void;
}

export interface SettingsOnboardingSlotOwner {
  stepId: string;
  complete: () => void;
  openSection: (id: string) => void;
}

export interface ConversationHeaderLineageSlotOwner {
  lineageSessionId: string;
  displayTitle: string;
  openTitle?: () => void;
}

export interface ConversationViewSlotOwner {
  inspect?: { callId: string } | null;
  onInspectDone?: () => void;
}

export interface ConversationNodeSlotOwner {
  node: unknown;
  selectedCallId?: string;
  cwd?: string;
  openFile?: (path: string) => void;
  inspectCall?: (callId: string) => void;
  forkAt?: (seq: number) => void;
}

export interface TurnTailSlotOwner {
  node: unknown;
}

export interface AssistantActionSlotOwner {
  messageId: string;
}

export interface CommandViewSlotOwner {
  node: unknown;
}

export interface ToolViewSlotOwner {
  callId: string;
  toolName: string;
  block: unknown;
  cwd?: string;
  home?: string;
  openFile?: (path: string) => void;
  inspect?: () => void;
}

export interface ComposerSlotOwner {
  active: boolean;
  locked: boolean;
}

export interface InputZoneSlotOwner {
  session: unknown;
  input: unknown;
}

export interface MessageImagesSlotOwner {
  messageId: string;
  images: readonly unknown[];
}

export interface RootSlotOwner {
  children: ReactNode;
}

declare module './ui-slots.js' {
  interface SlotMap {
    sidebar: { kind: 'single'; scope: 'root'; owner: FrameSlotOwner };
    conversation: { kind: 'single'; scope: 'session-maybe'; owner: EmptySlotOwner };
    details: { kind: 'single'; scope: 'session'; owner: EmptySlotOwner };
    'shell.overlay': { kind: 'list'; scope: 'root'; owner: EmptySlotOwner };
    'sidebar.brand.mark': { kind: 'single'; scope: 'root'; owner: BrandMarkSlotOwner };
    'sidebar.brand.name': { kind: 'single'; scope: 'root'; owner: EmptySlotOwner };
    'sidebar.workspaces': { kind: 'single'; scope: 'root'; owner: SidebarSectionSlotOwner };
    'sidebar.workspaces.directoryFlow': { kind: 'single'; scope: 'root'; owner: EmptySlotOwner };
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarSectionSlotOwner };
    'sidebar.settings': { kind: 'single'; scope: 'root'; owner: SidebarSectionSlotOwner };
    'settings.trigger': { kind: 'single'; scope: 'root'; owner: SidebarSectionSlotOwner };
    'settings.header': { kind: 'single'; scope: 'root'; owner: EmptySlotOwner };
    'settings.action': { kind: 'list'; scope: 'root'; owner: EmptySlotOwner };
    'settings.close': { kind: 'single'; scope: 'root'; owner: EmptySlotOwner };
    'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionSlotOwner };
    'settings.plugins.tab': { kind: 'list'; scope: 'root'; owner: EmptySlotOwner };
    'settings.onboarding': { kind: 'list'; scope: 'root'; owner: SettingsOnboardingSlotOwner };
    'settings.general.item': { kind: 'list'; scope: 'root'; owner: EmptySlotOwner };
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: EmptySlotOwner };
    'conversation.session': { kind: 'single'; scope: 'session'; owner: EmptySlotOwner };
    'conversation.session.header': { kind: 'single'; scope: 'session'; owner: EmptySlotOwner };
    'conversation.session.header.actions': { kind: 'list'; scope: 'session'; owner: EmptySlotOwner };
    'conversation.session.header.lineage': {
      kind: 'single';
      scope: 'session';
      owner: ConversationHeaderLineageSlotOwner;
    };
    'conversation.session.header.utilities': { kind: 'list'; scope: 'session'; owner: EmptySlotOwner };
    'conversation.view': { kind: 'list'; scope: 'session'; owner: ConversationViewSlotOwner };
    'conversation.chat.node': { kind: 'keyed'; scope: 'session'; owner: ConversationNodeSlotOwner };
    'conversation.chat.commandview': { kind: 'keyed'; scope: 'session'; owner: CommandViewSlotOwner };
    'conversation.chat.turnTail': { kind: 'chain'; scope: 'session'; owner: TurnTailSlotOwner };
    'conversation.chat.assistant-actions': { kind: 'list'; scope: 'session'; owner: AssistantActionSlotOwner };
    'conversation.message.images': { kind: 'single'; scope: 'session'; owner: MessageImagesSlotOwner };
    'conversation.composer': { kind: 'chain'; scope: 'session'; owner: ComposerSlotOwner };
    'conversation.composer.bar': { kind: 'single'; scope: 'session-maybe'; owner: ComposerSlotOwner };
    'conversation.composer.dock': { kind: 'list'; scope: 'session'; owner: InputZoneSlotOwner };
    'conversation.input.overlay': { kind: 'list'; scope: 'session'; owner: EmptySlotOwner };
    'conversation.input.dock': { kind: 'list'; scope: 'session'; owner: InputZoneSlotOwner };
    'conversation.input.left': { kind: 'list'; scope: 'session'; owner: InputZoneSlotOwner };
    'conversation.input.right': { kind: 'list'; scope: 'session'; owner: InputZoneSlotOwner };
    'conversation.input.attachments': { kind: 'single'; scope: 'session-maybe'; owner: ComposerSlotOwner };
    'conversation.input.plan': { kind: 'single'; scope: 'session'; owner: ComposerSlotOwner };
    'conversation.input.model': { kind: 'single'; scope: 'session'; owner: ComposerSlotOwner };
    'conversation.hero.workspace': { kind: 'single'; scope: 'root'; owner: EmptySlotOwner };
    'conversation.hero.workspace.directoryFlow': { kind: 'single'; scope: 'root'; owner: EmptySlotOwner };
    'conversation.hero.brand.mark': { kind: 'single'; scope: 'root'; owner: BrandMarkSlotOwner };
    'conversation.hero.agentPreset': { kind: 'single'; scope: 'root'; owner: EmptySlotOwner };
    'conversation.details.tool': { kind: 'single'; scope: 'session'; owner: ToolViewSlotOwner };
    'tool.call.toolview': { kind: 'keyed'; scope: 'session'; owner: ToolViewSlotOwner };
    'tool.view.cordis': { kind: 'keyed'; scope: 'session'; owner: ToolViewSlotOwner };
  }
}

/** Exact DSH b150a551b slot names, kinds, and scopes. */
export const MAKA_UI_SLOT_SPECS = {
  conversation: { kind: 'single', scope: 'session-maybe' },
  'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
  'conversation.chat.commandview': { kind: 'keyed', scope: 'session' },
  'conversation.chat.node': { kind: 'keyed', scope: 'session' },
  'conversation.chat.turnTail': { kind: 'chain', scope: 'session' },
  'conversation.composer': { kind: 'chain', scope: 'session' },
  'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
  'conversation.composer.dock': { kind: 'list', scope: 'session' },
  'conversation.details.tool': { kind: 'single', scope: 'session' },
  'conversation.hero.agentPreset': { kind: 'single', scope: 'root' },
  'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
  'conversation.hero.workspace': { kind: 'single', scope: 'root' },
  'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' },
  'conversation.input.attachments': { kind: 'single', scope: 'session-maybe' },
  'conversation.input.dock': { kind: 'list', scope: 'session' },
  'conversation.input.left': { kind: 'list', scope: 'session' },
  'conversation.input.model': { kind: 'single', scope: 'session' },
  'conversation.input.overlay': { kind: 'list', scope: 'session' },
  'conversation.input.plan': { kind: 'single', scope: 'session' },
  'conversation.input.right': { kind: 'list', scope: 'session' },
  'conversation.message.images': { kind: 'single', scope: 'session' },
  'conversation.session': { kind: 'single', scope: 'session' },
  'conversation.session.header': { kind: 'single', scope: 'session' },
  'conversation.session.header.actions': { kind: 'list', scope: 'session' },
  'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
  'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
  'conversation.view': { kind: 'list', scope: 'session' },
  details: { kind: 'single', scope: 'session' },
  'settings.action': { kind: 'list', scope: 'root' },
  'settings.close': { kind: 'single', scope: 'root' },
  'settings.general.item': { kind: 'list', scope: 'root' },
  'settings.header': { kind: 'single', scope: 'root' },
  'settings.onboarding': { kind: 'list', scope: 'root' },
  'settings.plugin.item': { kind: 'keyed', scope: 'root' },
  'settings.plugins.tab': { kind: 'list', scope: 'root' },
  'settings.section': { kind: 'list', scope: 'root' },
  'settings.trigger': { kind: 'single', scope: 'root' },
  'shell.overlay': { kind: 'list', scope: 'root' },
  sidebar: { kind: 'single', scope: 'root' },
  'sidebar.brand.mark': { kind: 'single', scope: 'root' },
  'sidebar.brand.name': { kind: 'single', scope: 'root' },
  'sidebar.footer.action': { kind: 'list', scope: 'root' },
  'sidebar.settings': { kind: 'single', scope: 'root' },
  'sidebar.workspaces': { kind: 'single', scope: 'root' },
  'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
  'tool.call.toolview': { kind: 'keyed', scope: 'session' },
  'tool.view.cordis': { kind: 'keyed', scope: 'session' },
} as const satisfies ChildrenDecl;

/** Create one Renderer-local registry with no legacy aliases or iframe seats. */
export function createMakaUiSlotCore(): SlotCore {
  const core = new SlotCore();
  core.register(
    {
      name: 'root',
      registrant: 'maka-desktop-renderer',
      children: MAKA_UI_SLOT_SPECS,
    },
    ({ children }: PropsRuntime<'root'>) => children,
  );
  return core;
}
