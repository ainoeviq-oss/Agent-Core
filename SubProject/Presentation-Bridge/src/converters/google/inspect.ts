import type { GoogleSlidesPresentation } from './rest.js';

export interface GooglePresentationSummary {
  slideCount: number; pageElements: number; shapes: number; images: number; tables: number; lines: number; groups: number; videos: number; sheetsCharts: number; speakerNotesPages: number;
}

export function summarizeGooglePresentation(presentation: GoogleSlidesPresentation): GooglePresentationSummary {
  const slides = presentation.slides ?? [];
  const summary: GooglePresentationSummary = { slideCount: slides.length, pageElements: 0, shapes: 0, images: 0, tables: 0, lines: 0, groups: 0, videos: 0, sheetsCharts: 0, speakerNotesPages: 0 };
  for (const rawSlide of slides) {
    const slide = rawSlide as { slideProperties?: { notesPage?: unknown }; pageElements?: Array<Record<string, unknown>> };
    if (slide.slideProperties?.notesPage) summary.speakerNotesPages += 1;
    for (const element of slide.pageElements ?? []) {
      summary.pageElements += 1;
      summary.shapes += Number(Boolean(element.shape)); summary.images += Number(Boolean(element.image)); summary.tables += Number(Boolean(element.table));
      summary.lines += Number(Boolean(element.line)); summary.groups += Number(Boolean(element.elementGroup)); summary.videos += Number(Boolean(element.video)); summary.sheetsCharts += Number(Boolean(element.sheetsChart));
    }
  }
  return summary;
}
