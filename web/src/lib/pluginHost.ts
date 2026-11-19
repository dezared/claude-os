// What a plugin's interface code gets in `activate(host)` besides the basics in uiPlugins.tsx: navigation, the cache, and the
// core's own components and icons, so a plugin screen looks and behaves like the rest of Claude OS in both themes.
// Made on first use: these modules import half the app, and the plugin loader is imported by some of them.
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, AtSign, BookOpen, Bookmark, Bot, Bug, Check, ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, CircleCheck, Clock, Coins, Columns3, Equal, Filter, Flag,
  FolderGit2, History, Keyboard, ListTodo, MessageSquare, MessageSquarePlus, Milestone, MoreHorizontal, Pencil, Play, Plus, Search, Settings, Sparkles, SquareCheck, SquareKanban, Tag, Trash2, User,
  UserRoundX, Wrench, X, Zap,
} from 'lucide-react';
import { claudeItems, ContextArea, openContextMenu } from '@/components/ContextMenu';
import { Markdown } from '@/components/Markdown';
import { ProjectIcon } from '@/components/ProjectIcon';
import { ProjectSelect } from '@/components/ProjectSelect';
import { Empty, ErrorState, Skeleton } from '@/components/states';
import { Button, Checkbox, Dialog, Field, IconButton, Input, Segmented, Select, Textarea } from '@/components/ui';
import type { MenuItem } from '@/home/ActionMenu';
import { dragMention, mentionFor, tagInChat } from '@/notes/mention';
import { useShowCost } from './account';
import { invalidateTopics, setCached } from './api';
import { cn, fmtAgo, fmtDateTime, fmtTokens, fmtUsd } from './format';
import { useProjectColors } from './projectColors';
import { useApp } from './store';
import { createTab, openSession } from './tabs';

const ICONS = {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, AtSign, BookOpen, Bookmark, Bot, Bug, Check, ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, CircleCheck, Clock, Coins, Columns3, Equal, Filter, Flag,
  FolderGit2, History, Keyboard, ListTodo, MessageSquare, MessageSquarePlus, Milestone, MoreHorizontal, Pencil, Play, Plus, Search, Settings, Sparkles, SquareCheck, SquareKanban, Tag, Trash2, User,
  UserRoundX, Wrench, X, Zap,
};

function makeHost() {
  return {
    setCached,
    refresh: invalidateTopics,
    go: (view: Parameters<ReturnType<typeof useApp.getState>['go']>[0]) => useApp.getState().go(view),
    ui: { Button, IconButton, Input, Textarea, Field, Checkbox, Dialog, Select, Segmented, Markdown, ProjectIcon, ProjectSelect, ContextArea, Empty, ErrorState, Skeleton },
    icons: ICONS,
    claudeItems,
    // A menu under the button that was pressed, the same one a right click opens.
    openMenu: (e: { currentTarget: Element }, items: MenuItem[]) => {
      const box = e.currentTarget.getBoundingClientRect();
      openContextMenu(box.left, box.bottom + 4, [items], e.currentTarget);
    },
    tabs: { createTab, openSession },
    mention: { dragMention, mentionFor, tagInChat },
    useShowCost,
    useProjectColors,
    format: { cn, fmtAgo, fmtDateTime, fmtTokens, fmtUsd },
  };
}

export type PluginHost = ReturnType<typeof makeHost>;

let made: PluginHost | null = null;
export const pluginHost = (): PluginHost => (made ??= makeHost());
