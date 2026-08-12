const PORTRAIT_COLUMNS = 4;
const LANDSCAPE_COLUMNS = 6;
const MIN_ROWS = 2;
const MAX_ROWS = 6;
const MOBILE_TOPBAR_HEIGHT = 40;
const MOBILE_DOCK_RESERVE = 72;
const MOBILE_GRID_VERTICAL_PADDING = 16;
const PAGE_INDICATOR_RESERVE = 24;
const TARGET_CELL_HEIGHT = 92;

export const mobileDesktopLayout = ({ width, height, itemCount }) => {
  const columns = width > height ? LANDSCAPE_COLUMNS : PORTRAIT_COLUMNS;
  const usableHeight = Math.max(
    MIN_ROWS * TARGET_CELL_HEIGHT,
    height - MOBILE_TOPBAR_HEIGHT - MOBILE_DOCK_RESERVE - MOBILE_GRID_VERTICAL_PADDING - PAGE_INDICATOR_RESERVE
  );
  const rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.floor(usableHeight / TARGET_CELL_HEIGHT)));
  const itemsPerPage = columns * rows;

  return {
    columns,
    rows,
    itemsPerPage,
    pageCount: Math.max(1, Math.ceil(itemCount / itemsPerPage))
  };
};

export const paginateDesktopItems = (items, itemsPerPage) => {
  const pages = [];
  for (let index = 0; index < items.length; index += itemsPerPage) {
    pages.push(items.slice(index, index + itemsPerPage));
  }
  return pages.length ? pages : [[]];
};
