"""Reject production assets in the current public Git tree (including forced additions)."""
import pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[1]
files=subprocess.check_output(['git','ls-files','--cached','-z'],cwd=root).decode('utf-8').split('\0')
allowed_images={'assets/demo-whale.svg','docs/images/whalesong-preview.png','desktop/icon-source.png','desktop/windows/build/icon.png'}
forbidden={'.mp4','.webm','.mov','.gif','.apng','.zip','.7z','.psd','.psb','.blend','.moc3','.exe','.ico','.jpg','.jpeg','.webp','.avif','.bin'}
bad=[]
for name in files:
 if not name:continue
 file=root/name
 if not file.exists():continue
 lower=name.lower();ext=file.suffix.lower()
 if lower.startswith(('assets/songm/','assets/model/','tools/animation-src/','docs/validation','outputs/','work/')) or ext in forbidden or (ext in {'.png','.svg'} and name not in allowed_images) or any(t in lower for t in ['generation-prompt','faces-v3','master.png','private-assets','asset-pack']):bad.append(name)
 if ext in {'.png','.svg'} and name in allowed_images and file.stat().st_size>500000:bad.append(name+' (oversized public image)')
if bad:
 print('PUBLIC ASSET CHECK FAILED:\n'+'\n'.join(bad));sys.exit(1)
print('Public asset check passed: no production artwork, videos or archives tracked.')
