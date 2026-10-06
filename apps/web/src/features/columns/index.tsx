// The columns of the sessions view (DESIGN §5.4, UX §2): the strip with its dividers and the frame around what a
// column shows. What a column shows is a feature's component, registered in that feature's slots.tsx (lib/slots.ts).
export { ColumnFrame, ColumnPictureIcon, columnName, useColumnDescription, type ColumnFrameProps } from './ColumnFrame.tsx';
export { ColumnStrip, type ColumnStripProps } from './ColumnStrip.tsx';
export { SideColumn, type SideColumnProps } from './SideColumn.tsx';
import { t } from './strings.ts';

/** The name of the landmark the strip stands in: "Open columns". */
export const columnsRegionLabel = (): string => t('region');
