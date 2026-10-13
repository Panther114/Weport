"""Read actual exported artifacts independently of the Electron exporter."""
import csv,hashlib,io,json,pathlib,re,sqlite3,sys,zipfile,xml.etree.ElementTree as ET
format,path=sys.argv[1:];p=pathlib.Path(path);b=p.read_bytes()
expected=['Synthetic incoming message','Synthetic outgoing message']
if format=='excel':
 with zipfile.ZipFile(p) as z:
  xml=z.read('xl/sharedStrings.xml');root=ET.fromstring(xml)
  strings=[''.join(e.itertext()) for e in root]
  ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
  sheet=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
  contents=[]
  for cell in sheet.findall('.//m:c',ns):
   v=cell.find('m:v',ns)
   if cell.get('t')=='s' and v is not None and strings[int(v.text)] in expected:contents.append(strings[int(v.text)])
elif format=='sql':
 db=sqlite3.connect(':memory:');db.executescript(b.decode('utf-8-sig'))
 rows=db.execute('select local_id,message_id,is_send,content from weflow_messages order by local_id').fetchall()
 assert rows==[('1','1001',0,expected[0]),('2','1002',1,expected[1])],rows
 contents=[r[3] for r in rows]
elif format=='weclone':
 rows=list(csv.DictReader(io.StringIO(b.decode('utf-8-sig'))));contents=[r['msg'] for r in rows]
 assert [r['MsgSvrID'] for r in rows]==['1001','1002']
elif format in ('json','arkme-json','chatlab'):
 rows=json.loads(b)['messages'];contents=[r['content'] for r in rows]
elif format=='chatlab-jsonl':
 rows=[json.loads(line) for line in b.decode().splitlines()];contents=[r['content'] for r in rows if r.get('_type')=='message']
elif format=='html':
 text=b.decode();match=re.search(r'window\.WEFLOW_DATA\s*=\s*(\[.*?\]);',text,re.S);assert match
 rows=json.loads(match.group(1));contents=[next(x for x in expected if x in row['b']) for row in rows]
else:
 text=b.decode('utf-8-sig');contents=[x for x in expected for _ in range(text.count(x))]
assert sorted(contents)==sorted(expected),(format,contents)
print(json.dumps({'format':format,'independentRows':len(contents),'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)}))
