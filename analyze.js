import ExcelJS from 'exceljs';

async function analyze() {
    const file2 = "C:\\Users\\wanle.INDY\\Downloads\\Liquidacion_FAMILYARG_2026-06-01_a_2026-06-25.xlsx";
    const workbook2 = new ExcelJS.Workbook();
    await workbook2.xlsx.readFile(file2);

    for (const sheet of workbook2.worksheets) {
        if (sheet.name.startsWith('Liq - ')) {
            const headers = sheet.getRow(4).values;
            const indexType = headers.indexOf('Tipo') > -1 ? headers.indexOf('Tipo') : headers.findIndex(h => h && h.toLowerCase().includes('tipo') || h === 'Devoluciones'); // actually it's "Tipo" or similar
            
            for (let i = 5; i <= sheet.rowCount; i++) {
                const values = sheet.getRow(i).values;
                if (values[1] && values[1].toString().trim() === '#202890') {
                    console.log(`Headers:`, headers);
                    console.log(`App data:`, values);
                }
            }
        }
    }
}

analyze().catch(console.error);
