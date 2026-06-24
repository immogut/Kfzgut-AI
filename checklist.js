/**
 * KfzGut-AI – Checklisten-Generator
 * Erstellt eine formatierte Word-Datei (.docx) aus den Prüfergebnissen
 */
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign } = require('docx');

const INK='1E2433', BLUE='1A56A0', ORANGE='D95F1A', GREEN='1A6E3A', RED='C02828';
const WHITE='FFFFFF', BG='F0F2F6', BORDER='E0E3EA';
const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const nb = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

function ampelColor(a){ return a==='rot'?RED:(a==='orange'||a==='gelb')?'C9A000':GREEN; }
function ampelLabel(a){ return a==='rot'?'● Dringend':(a==='orange'||a==='gelb')?'● Hinweis':'● OK'; }
function sp(h=160){ return new Paragraph({ spacing:{ before:h, after:0 }, children:[] }); }

async function buildChecklist({ kategorien, zusammenfassung, gesamtbewertung }){

  function headerBar(){
    return new Table({ width:{ size:9026, type:WidthType.DXA }, columnWidths:[7026,2000],
      rows:[new TableRow({ children:[
        new TableCell({ borders:nb, shading:{ fill:INK, type:ShadingType.CLEAR }, margins:{ top:220,bottom:220,left:300,right:120 }, width:{ size:7026, type:WidthType.DXA },
          children:[new Paragraph({ children:[
            new TextRun({ text:'Immo', font:'Georgia', size:36, color:WHITE }),
            new TextRun({ text:'Gut', font:'Georgia', size:36, color:'AAAAAA' }),
            new TextRun({ text:'-AI', font:'Georgia', size:36, color:ORANGE }),
            new TextRun({ text:'   Prüfbericht & Checkliste', font:'Arial', size:20, color:'AAAAAA' }),
          ]})]
        }),
        new TableCell({ borders:nb, shading:{ fill:INK, type:ShadingType.CLEAR }, margins:{ top:220,bottom:220,left:120,right:300 }, width:{ size:2000, type:WidthType.DXA }, verticalAlign:VerticalAlign.CENTER,
          children:[new Paragraph({ alignment:AlignmentType.RIGHT,
            children:[new TextRun({ text:new Date().toLocaleDateString('de-DE'), font:'Arial', size:18, color:'AAAAAA' })]
          })]
        }),
      ]})]
    });
  }

  function summaryBar(){
    const bg = gesamtbewertung==='rot'?'FDF0F0':(gesamtbewertung==='orange'||gesamtbewertung==='gelb')?'FEF9E0':'E8F5ED';
    const col = ampelColor(gesamtbewertung);
    return new Table({ width:{ size:9026, type:WidthType.DXA }, columnWidths:[9026],
      rows:[new TableRow({ children:[
        new TableCell({ borders:nb, shading:{ fill:bg, type:ShadingType.CLEAR }, margins:{ top:180,bottom:180,left:300,right:300 }, width:{ size:9026, type:WidthType.DXA },
          children:[new Paragraph({ children:[
            new TextRun({ text:ampelLabel(gesamtbewertung)+'  ', font:'Arial', size:22, bold:true, color:col }),
            new TextRun({ text:zusammenfassung||'Prüfung abgeschlossen', font:'Arial', size:20, color:INK }),
          ]})]
        }),
      ]})]
    });
  }

  function legendBar(){
    return new Table({ width:{ size:9026, type:WidthType.DXA }, columnWidths:[3000,3000,3026],
      rows:[new TableRow({ children:[
        new TableCell({ borders:nb, shading:{ fill:BG, type:ShadingType.CLEAR }, margins:{ top:100,bottom:100,left:200,right:100 }, width:{ size:3000, type:WidthType.DXA },
          children:[new Paragraph({ children:[new TextRun({ text:'● Dringend ', font:'Arial', size:17, bold:true, color:RED }), new TextRun({ text:'= schwerer Fehler', font:'Arial', size:17, color:'666666' })] })] }),
        new TableCell({ borders:nb, shading:{ fill:BG, type:ShadingType.CLEAR }, margins:{ top:100,bottom:100,left:100,right:100 }, width:{ size:3000, type:WidthType.DXA },
          children:[new Paragraph({ children:[new TextRun({ text:'● Hinweis ', font:'Arial', size:17, bold:true, color:ORANGE }), new TextRun({ text:'= prüfen', font:'Arial', size:17, color:'666666' })] })] }),
        new TableCell({ borders:nb, shading:{ fill:BG, type:ShadingType.CLEAR }, margins:{ top:100,bottom:100,left:100,right:200 }, width:{ size:3026, type:WidthType.DXA },
          children:[new Paragraph({ children:[new TextRun({ text:'● OK ', font:'Arial', size:17, bold:true, color:GREEN }), new TextRun({ text:'= keine Beanstandungen', font:'Arial', size:17, color:'666666' })] })] }),
      ]})]
    });
  }

  function categoryRows(kat){
    const col = ampelColor(kat.ampel);
    const noFind = kat.punkte.length===1 && kat.punkte[0].toLowerCase().includes('keine beanstandungen');
    const rows = [];
    // Header row
    rows.push(new TableRow({ children:[
      new TableCell({ borders:nb, shading:{ fill:col, type:ShadingType.CLEAR }, width:{ size:120, type:WidthType.DXA }, children:[new Paragraph({ children:[] })] }),
      new TableCell({ borders:nb, shading:{ fill:noFind?'FAFBFC':BG, type:ShadingType.CLEAR }, margins:{ top:140,bottom:140,left:220,right:120 }, width:{ size:6586, type:WidthType.DXA },
        children:[new Paragraph({ children:[new TextRun({ text:kat.name, font:'Arial', size:22, bold:true, color:INK })] })] }),
      new TableCell({ borders:nb, shading:{ fill:noFind?'FAFBFC':BG, type:ShadingType.CLEAR }, margins:{ top:140,bottom:140,left:120,right:220 }, width:{ size:2320, type:WidthType.DXA }, verticalAlign:VerticalAlign.CENTER,
        children:[new Paragraph({ alignment:AlignmentType.RIGHT, children:[new TextRun({ text:ampelLabel(kat.ampel), font:'Arial', size:18, bold:true, color:col })] })] }),
    ]}));
    if(!noFind){
      kat.punkte.forEach((p,i) => {
        const pageRef = (p.match(/^(Seite \d+)/i)||[''])[0];
        const pText = p.replace(/^Seite \d+:?\s*/i,'');
        rows.push(new TableRow({ children:[
          new TableCell({ borders:nb, shading:{ fill:'F4F5F8', type:ShadingType.CLEAR }, width:{ size:120, type:WidthType.DXA }, children:[new Paragraph({ children:[] })] }),
          new TableCell({ borders:nb, shading:{ fill:WHITE, type:ShadingType.CLEAR }, margins:{ top:130,bottom:130,left:220,right:120 }, width:{ size:6586, type:WidthType.DXA },
            children:[new Paragraph({ children:[
              new TextRun({ text:'☐  ', font:'Arial', size:20, color:'AAAAAA' }),
              new TextRun({ text:pText, font:'Arial', size:19, color:INK }),
            ]})] }),
          new TableCell({ borders:nb, shading:{ fill:WHITE, type:ShadingType.CLEAR }, margins:{ top:130,bottom:130,left:120,right:220 }, width:{ size:2320, type:WidthType.DXA }, verticalAlign:VerticalAlign.CENTER,
            children:[new Paragraph({ alignment:AlignmentType.RIGHT, children:[new TextRun({ text:pageRef, font:'Arial', size:17, bold:true, color:BLUE })] })] }),
        ]}));
        if(i < kat.punkte.length-1){
          rows.push(new TableRow({ children:[
            new TableCell({ borders:nb, shading:{ fill:'F4F5F8', type:ShadingType.CLEAR }, width:{ size:120, type:WidthType.DXA }, children:[new Paragraph({ children:[] })] }),
            new TableCell({ borders:{ top:noBorder, bottom:{ style:BorderStyle.SINGLE, size:1, color:BORDER }, left:noBorder, right:noBorder },
              shading:{ fill:WHITE, type:ShadingType.CLEAR }, width:{ size:8906, type:WidthType.DXA }, children:[new Paragraph({ children:[] })] }),
          ]}));
        }
      });
    } else {
      rows.push(new TableRow({ children:[
        new TableCell({ borders:nb, shading:{ fill:'F4F5F8', type:ShadingType.CLEAR }, width:{ size:120, type:WidthType.DXA }, children:[new Paragraph({ children:[] })] }),
        new TableCell({ borders:nb, shading:{ fill:WHITE, type:ShadingType.CLEAR }, margins:{ top:100,bottom:100,left:220,right:120 }, width:{ size:8906, type:WidthType.DXA },
          children:[new Paragraph({ children:[new TextRun({ text:'✓  Keine Beanstandungen', font:'Arial', size:18, color:GREEN })] })] }),
      ]}));
    }
    return rows;
  }

  function disclaimerBlock(){
    return new Table({ width:{ size:9026, type:WidthType.DXA }, columnWidths:[9026],
      rows:[new TableRow({ children:[
        new TableCell({
          borders:{ top:{ style:BorderStyle.SINGLE, size:2, color:BORDER }, bottom:noBorder, left:noBorder, right:noBorder },
          shading:{ fill:'F8F9FB', type:ShadingType.CLEAR }, margins:{ top:220,bottom:220,left:300,right:300 }, width:{ size:9026, type:WidthType.DXA },
          children:[
            new Paragraph({ children:[new TextRun({ text:'Rechtlicher Hinweis', font:'Arial', size:18, bold:true, color:INK })] }),
            new Paragraph({ spacing:{ before:80, after:0 }, children:[new TextRun({
              text:'Dieser Prüfbericht wurde automatisch durch KfzGut-AI erstellt und dient ausschließlich als Arbeitshilfe. KfzGut-AI ersetzt nicht die fachliche Beurteilung durch einen öffentlich bestellten und vereidigten Sachverständigen. Die rechtliche und fachliche Verantwortung für das fertige Gutachten liegt ausschließlich beim Verfasser. Alle Hinweise sind vor Verwendung eigenverantwortlich zu prüfen. KfzGut-AI übernimmt keine Haftung für Schäden aus der Verwendung dieses Berichts.',
              font:'Arial', size:16, color:'777777'
            })] }),
            new Paragraph({ spacing:{ before:100, after:0 }, children:[new TextRun({
              text:'Erstellt mit KfzGut-AI  ·  kfzgut-ai.de  ·  '+new Date().toLocaleDateString('de-DE'),
              font:'Arial', size:15, color:'BBBBBB'
            })] }),
          ],
        }),
      ]})]
    });
  }

  const allRows = [];
  for(const kat of kategorien){
    categoryRows(kat).forEach(r => allRows.push(r));
    allRows.push(new TableRow({ children:[
      new TableCell({ borders:nb, width:{ size:120, type:WidthType.DXA }, children:[new Paragraph({ children:[] })] }),
      new TableCell({ borders:nb, width:{ size:8906, type:WidthType.DXA }, children:[new Paragraph({ spacing:{ before:60, after:60 }, children:[] })] }),
    ]}));
  }

  const doc = new Document({
    styles:{ default:{ document:{ run:{ font:'Arial', size:20 } } } },
    sections:[{ properties:{ page:{ size:{ width:11906, height:16838 }, margin:{ top:800, right:800, bottom:1200, left:800 } }},
      children:[
        headerBar(), sp(180),
        summaryBar(), sp(180),
        legendBar(), sp(280),
        new Table({ width:{ size:9026, type:WidthType.DXA }, columnWidths:[120,6586,2320], rows:allRows }),
        sp(400),
        disclaimerBlock(),
      ],
    }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildChecklist };
