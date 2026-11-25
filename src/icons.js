import align_center from 'lucide/icons/align-center.svg?raw';
import align_justify from 'lucide/icons/align-justify.svg?raw';
import align_left from 'lucide/icons/align-left.svg?raw';
import align_right from 'lucide/icons/align-right.svg?raw';
import arrow_up_right from 'lucide/icons/arrow-up-right.svg?raw';
import baseline from 'lucide/icons/baseline.svg?raw';
import bold from 'lucide/icons/bold.svg?raw';
import check from 'lucide/icons/check.svg?raw';
import chevron_down from 'lucide/icons/chevron-down.svg?raw';
import chevron_up from 'lucide/icons/chevron-up.svg?raw';
import circle_check from 'lucide/icons/circle-check.svg?raw';
import circle_help from 'lucide/icons/circle-help.svg?raw';
import clipboard from 'lucide/icons/clipboard.svg?raw';
import copy from 'lucide/icons/copy.svg?raw';
import download from 'lucide/icons/download.svg?raw';
import ellipsis from 'lucide/icons/ellipsis.svg?raw';
import file from 'lucide/icons/file.svg?raw';
import file_plus from 'lucide/icons/file-plus.svg?raw';
import file_text from 'lucide/icons/file-text.svg?raw';
import folder_open from 'lucide/icons/folder-open.svg?raw';
import highlighter from 'lucide/icons/highlighter.svg?raw';
import image from 'lucide/icons/image.svg?raw';
import italic from 'lucide/icons/italic.svg?raw';
import link_2 from 'lucide/icons/link-2.svg?raw';
import list from 'lucide/icons/list.svg?raw';
import list_checks from 'lucide/icons/list-checks.svg?raw';
import list_collapse from 'lucide/icons/list-collapse.svg?raw';
import list_ordered from 'lucide/icons/list-ordered.svg?raw';
import list_tree from 'lucide/icons/list-tree.svg?raw';
import minus from 'lucide/icons/minus.svg?raw';
import panel_left from 'lucide/icons/panel-left.svg?raw';
import pilcrow from 'lucide/icons/pilcrow.svg?raw';
import plus from 'lucide/icons/plus.svg?raw';
import printer from 'lucide/icons/printer.svg?raw';
import redo_2 from 'lucide/icons/redo-2.svg?raw';
import scan_line from 'lucide/icons/scan-line.svg?raw';
import search from 'lucide/icons/search.svg?raw';
import settings from 'lucide/icons/settings.svg?raw';
import strikethrough from 'lucide/icons/strikethrough.svg?raw';
import table_2 from 'lucide/icons/table-2.svg?raw';
import trash_2 from 'lucide/icons/trash-2.svg?raw';
import underline from 'lucide/icons/underline.svg?raw';
import undo_2 from 'lucide/icons/undo-2.svg?raw';
import unlink from 'lucide/icons/unlink.svg?raw';
import x from 'lucide/icons/x.svg?raw';

const icons = {
  'align-center': align_center,
  'align-justify': align_justify,
  'align-left': align_left,
  'align-right': align_right,
  'arrow-up-right': arrow_up_right,
  'baseline': baseline,
  'bold': bold,
  'check': check,
  'chevron-down': chevron_down,
  'chevron-up': chevron_up,
  'circle-check': circle_check,
  'circle-help': circle_help,
  'clipboard': clipboard,
  'copy': copy,
  'download': download,
  'ellipsis': ellipsis,
  'file': file,
  'file-plus': file_plus,
  'file-text': file_text,
  'folder-open': folder_open,
  'highlighter': highlighter,
  'image': image,
  'italic': italic,
  'link-2': link_2,
  'list': list,
  'list-checks': list_checks,
  'list-collapse': list_collapse,
  'list-ordered': list_ordered,
  'list-tree': list_tree,
  'minus': minus,
  'panel-left': panel_left,
  'pilcrow': pilcrow,
  'plus': plus,
  'printer': printer,
  'redo-2': redo_2,
  'scan-line': scan_line,
  'search': search,
  'settings': settings,
  'strikethrough': strikethrough,
  'table-2': table_2,
  'trash-2': trash_2,
  'underline': underline,
  'undo-2': undo_2,
  'unlink': unlink,
  'x': x,
};

export function icon(name) {
  return icons[name] ?? file;
}

export function mountIcons(scope = document) {
  scope.querySelectorAll('[data-icon]').forEach((element) => {
    element.innerHTML = icon(element.dataset.icon);
    element.querySelector('svg').setAttribute('aria-hidden', 'true');
  });
}
