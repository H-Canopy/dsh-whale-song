/* WhaleSong 0.6.2: quiet reading and video-synchronized roaming. MIT code. */
;(function () {
  'use strict'
  window.__SONGM_RENDERER__ = 'v5-video-idle'
  window.createSongmRenderer = async function ({ base, state }) {
    const P=window.PIXI
    const loadImage=src=>new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(Error('素材加载失败：'+src));im.src=src})
    const [master,atlas,meta]=await Promise.all([loadImage(base+'/songm/master.png').catch(()=>loadImage(base+'/demo-whale.svg')),loadImage(base+'/songm/faces-v3.png').catch(()=>null),fetch(base+'/songm/renderer-manifest.json').then(r=>{if(!r.ok)throw Error('private assets absent');return r.json()}).catch(()=>({demo:true,clips:{},master:{headX:256,floorY:460,height:400}}))])
    const W=master.width,H=master.height
    const app=new P.Application({width:8,height:8,backgroundAlpha:0,antialias:true,autoDensity:true,preserveDrawingBuffer:true,resolution:Math.min(devicePixelRatio||1,2.5),powerPreference:'low-power'})
    app.ticker.maxFPS=30
    const model=new P.Container();model.anchor={set(){}}
    model.internalModel={width:W,height:H,originalWidth:W,originalHeight:H,focusController:{x:0,y:0,targetX:0,targetY:0},motionManager:{stopAllMotions(){},state:{}}}
    const textures={neutral:P.Texture.from(master)};if(meta.demo){for(const key of ['blink','thinking','happy','confused','sleepy','love'])textures[key]=textures.neutral}
    ;['blink','thinking','happy','confused','sleepy','love'].forEach((name,index)=>{
      if(!atlas||meta.demo)return;const c=document.createElement('canvas');c.width=W;c.height=H;const g=c.getContext('2d');g.drawImage(master,0,0)
      const cell=meta.faces.cells[index],ox=index%3*atlas.width/3,oy=Math.floor(index/3)*atlas.height/2
      for(const key of ['left','right','mouth']){
        const source=cell[key],target=meta.faces.targets[key],scale=meta.faces.scale,rw=key==='mouth'?33:85,rh=key==='mouth'?30:78
        const w=Math.round(rw*2*scale),h=Math.round(rh*2*scale),patch=document.createElement('canvas');patch.width=w;patch.height=h
        const p=patch.getContext('2d');p.drawImage(atlas,ox+source[0]-rw,oy+source[1]-rh,rw*2,rh*2,0,0,w,h)
        p.globalCompositeOperation='destination-in';p.translate(w/2,h/2);p.scale(w/2,h/2)
        const fade=p.createRadialGradient(0,0,.78,0,0,1);fade.addColorStop(0,'white');fade.addColorStop(1,'transparent');p.fillStyle=fade;p.fillRect(-1,-1,2,2)
        g.drawImage(patch,target[0]-w/2,target[1]-h/2)
      }
      textures[name]=P.Texture.from(c)
    })
    const sprite=new P.Sprite(textures.neutral),videoSprite=new P.Sprite(textures.neutral),outgoing=new P.Sprite(textures.neutral)
    for(const s of [sprite,videoSprite]){s.anchor.set(.5,1);s.position.set(W/2,H);model.addChild(s)}
    outgoing.anchor.set(.5,1);outgoing.visible=false;model.addChildAt(outgoing,1);videoSprite.visible=false;app.stage.addChild(model)
    const reduced=matchMedia('(prefers-reduced-motion: reduce)')
    let current={},face='neutral',action='',actionUntil=0,actionStart=0,dragging=false,dragAngle=0,lastInput=performance.now()
    let nextBlink=performance.now()+3800,blinkUntil=0,nextAmbient=performance.now()+65000,lastAmbient='',paused=false
    let requestId=0,active=null,fade=null,roamDir=0,roamEpoch=0,lastStatus='idle',lastError=''
    const videos=new Map(),loads=new Map(),history=[],now=()=>performance.now()
    let reading=false,readEpoch=0,readingUntil=0,nextReadingAt=now()+45000,roamId=null
    let ambientIndex=0
    let pendingName=null
    let intent=0
    let readingSource=null,held=false
    const faceOf=m=>['thinking','reading','focused','listening','serious'].includes(m)?'thinking':['happy','excited','smug','proud','playful'].includes(m)?'happy':['confused','worried','sad','angry','error','shock','surprised','gloomy','sweat','pout','grumpy'].includes(m)?'confused':['sleepy','sleep','tired'].includes(m)?'sleepy':['love','shy'].includes(m)?'love':'neutral'
    const record=(name,reason)=>{history.push({name,reason,at:now()});if(history.length>20)history.shift()}
    const busy=()=>current.status&&current.status!=='idle'
    const blocked=source=>paused||dragging||current.hidden||document.hidden||(source!=='manual'&&((source!=='base'&&current.blocked)||current.lowPower))
    function resetTransform(){for(const s of [sprite,videoSprite]){s.rotation=0;s.scale.set(1);s.position.set(W/2,H);s.anchor.set(.5,1)}}
    function restoreStatic(){held=false;outgoing.visible=false;sprite.visible=true;sprite.alpha=1;sprite.texture=textures[face]||textures.neutral;videoSprite.visible=false;videoSprite.alpha=0;resetTransform()}
    function clearPlayback(reason='cancelled',preserve=false){
      requestId++;fade=null;pendingName=null
      if(active){const old=active;active=null;old.video.pause();old.video.loop=false;old.video.onended=null;old.video.onerror=null;record(old.name,reason)}
      if(!preserve)restoreStatic();else held=true
    }
    function retire(reason='ended',callback){
      if(!active)return
      const old=active;old.video.pause();old.video.loop=false;old.video.onended=null;old.video.onerror=null;active=null;record(old.name,reason)
      held=true
      if(callback){callback();return}
      playClip('idle',{loop:true,source:'base',seamless:true})
    }
    async function loadVideo(name){
      if(videos.has(name))return videos.get(name)
      if(loads.has(name))return loads.get(name)
      const def=meta.clips[name];if(!def)throw Error('未知动作：'+name)
      const promise=(async()=>{
        const response=await fetch(base+'/songm/clips/'+def.file,{signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error('动作加载失败：'+name)
        const url=URL.createObjectURL(await response.blob()),v=document.createElement('video')
        v.muted=true;v.playsInline=true;v.preload='auto';v.style.cssText='position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';document.body.appendChild(v)
        try{
          await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('动作加载超时：'+name)),12000)
            v.onloadeddata=()=>{clearTimeout(timer);v.onloadeddata=null;v.onerror=null;resolve()}
            v.onerror=()=>{clearTimeout(timer);reject(Error('视频解码失败：'+name))};v.src=url
          })
          const resource=new P.VideoResource(v,{autoPlay:false});const texture=new P.Texture(new P.BaseTexture(resource));v.pause()
          const item={video:v,texture,url};videos.set(name,item);return item
        }catch(error){v.remove();URL.revokeObjectURL(url);throw error}
      })()
      loads.set(name,promise);try{return await promise}finally{loads.delete(name)}
    }
    async function playClip(name,{loop=false,direction=0,source='manual',onDone=null,seamless=false}={}){
      if(!meta.clips[name]||blocked(source)||busy())return false
      clearPlayback('replaced',true);const id=requestId;pendingName=name
      try{
        const item=await loadVideo(name)
        if(id!==requestId||blocked(source)||busy())return false
        const v=item.video;v.pause();v.loop=loop
        if(v.currentTime!==0){v.currentTime=0;await new Promise(resolve=>{if(!v.seeking)return resolve();v.addEventListener('seeked',resolve,{once:true});setTimeout(resolve,800)})}
        if(id!==requestId||blocked(source)||busy())return false
        await v.play()
        if(v.requestVideoFrameCallback)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('首帧解码超时：'+name)),3000);v.requestVideoFrameCallback(()=>{clearTimeout(timer);resolve()})})
        if(id!==requestId){v.pause();return false}
        if(videoSprite.visible){outgoing.texture=videoSprite.texture;outgoing.position.copyFrom(videoSprite.position);outgoing.scale.copyFrom(videoSprite.scale);outgoing.rotation=videoSprite.rotation;outgoing.alpha=1;outgoing.visible=true}
        held=false
        const fit=meta.clips[name].fit,flip=direction>0?-1:1
        videoSprite.texture=item.texture;videoSprite.anchor.set(.5,1);videoSprite.scale.set(fit.scale*flip,fit.scale)
        videoSprite.position.set(meta.master.headX+(v.videoWidth/2-fit.headX)*fit.scale*flip,meta.master.floorY+(v.videoHeight-fit.floorY)*fit.scale)
        videoSprite.rotation=0;videoSprite.visible=true;videoSprite.alpha=outgoing.visible?0:1;sprite.visible=false;sprite.alpha=0
        const entry={name,video:v,source,direction,id,onDone,loop,started:now()};active=entry
        v.onended=()=>{if(active===entry)retire('ended',onDone)}
        v.onerror=()=>{if(active===entry){lastError='播放失败：'+name;clearPlayback('error')}}
        if(id!==requestId){v.pause();return false}
        fade={kind:'in',start:now(),duration:80};record(name,'started');return true
      }catch(error){if(id===requestId){lastError=String(error.message||error);clearPlayback('error')}return false}
      finally{if(id===requestId)pendingName=null}
    }
    function resetReading(){reading=false;readingSource=null;readEpoch++;readingUntil=0;nextReadingAt=now()+90000;nextAmbient=now()+45000}
    async function startReading(source='manual'){
      if(reading||blocked(source)||busy()||roamDir)return false
      const epoch=++readEpoch;reading=true;readingSource=source;readingUntil=now()+50000
      const ok=await playClip('read-in',{source,onDone:()=>{if(reading&&epoch===readEpoch)playClip('read-loop',{loop:true,source,seamless:true})}})
      if(!ok&&epoch===readEpoch)resetReading();return ok
    }
    async function stopReading(graceful=true){
      if(!reading)return true
      resetReading()
      if(!graceful||blocked('manual')||busy()){clearPlayback('read-cancelled');return true}
      return new Promise(resolve=>{playClip('read-out',{source:'manual',seamless:true,onDone:resolve}).then(ok=>{if(!ok)resolve(false)});setTimeout(()=>resolve(false),6500)})
    }
    async function setRoam(value){
      const event=typeof value==='object'?value:{dir:value},d=Math.sign(event.dir||0)
      if(d===roamDir&&!event.cancelled)return
      const previous=roamDir;roamDir=d;roamId=event.id??null;const epoch=++roamEpoch
      if(d){
        if(reading)await stopReading(true)
        if(epoch!==roamEpoch||roamDir!==d)return
        action='';actionUntil=0
        const id=roamId
        const ok=await playClip('run-in',{direction:d,source:'roam',onDone:async()=>{
          if(epoch!==roamEpoch||roamDir!==d)return
          const playing=await playClip('run-loop',{loop:true,direction:d,source:'roam',seamless:true})
          if(playing&&epoch===roamEpoch)window.dshPetNative?.roamPhase?.({id,phase:'moving',cycle:meta.clips['run-loop'].duration})
        }})
        if(!ok&&epoch===roamEpoch){roamDir=0;window.dshPetNative?.roamPhase?.({id,phase:'failed'})}
      }
      else if(previous&&!event.cancelled&&!blocked('roam')&&!busy())playClip('run-out',{direction:previous,source:'roam',seamless:true})
      else clearPlayback('roam-cancelled')
    }
    if(window.dshPetNative?.onRoam)window.dshPetNative.onRoam(setRoam)
    const input=()=>{lastInput=now();nextAmbient=Math.max(nextAmbient,lastInput+45000)}
    addEventListener('pointerdown',input,{passive:true});addEventListener('pointermove',input,{passive:true})
    function suspend(){paused=true;intent++;resetReading();roamDir=0;roamEpoch++;clearPlayback('suspend')}
    function resume(){paused=false;nextAmbient=now()+60000;nextBlink=now()+3800;restoreStatic()}
    document.addEventListener('visibilitychange',()=>{if(document.hidden)suspend();else resume()})
    reduced.addEventListener('change',()=>{if(reduced.matches&&(readingSource==='ambient'||['ambient','base'].includes(active?.source))){resetReading();clearPlayback('reduced-motion')}})
    app.ticker.add(()=>{
      const t=now();current=state()
      if(active&&!active.loop&&Number.isFinite(active.video.duration)&&active.video.currentTime>=active.video.duration-.035&&t-active.started>200)retire('ended',active.onDone)
      if(busy()&&lastStatus==='idle'){intent++;resetReading();roamDir=0;roamEpoch++;clearPlayback('work')}
      lastStatus=current.status||'idle'
      if(current.hidden&&active){resetReading();roamDir=0;roamEpoch++;clearPlayback('hidden')}
      if(current.blocked&&active&&!['manual','base'].includes(active.source)){resetReading();roamDir=0;roamEpoch++;clearPlayback('panel')}
      if(current.lowPower&&active&&['ambient','base'].includes(active.source)){resetReading();clearPlayback('low-power')}
      if(reading&&t>=readingUntil&&active?.name==='read-loop')stopReading(true)
      const override=t<actionUntil?action:'';if(!override)action=''
      let mood=current.mood
      if(['greet','success','music'].includes(override))mood='happy'
      if(['think','listen'].includes(override))mood='thinking'
      if(override==='fail')mood='confused';if(override==='sleep')mood='sleepy'
      face=faceOf(mood)
      if(t>=nextBlink){blinkUntil=t+130;nextBlink=t+4200+Math.random()*1800}
      if(!active&&!dragging&&t<blinkUntil&&!['sleepy','love'].includes(face))face='blink'
      if(dragging)face='confused'
      if(!active&&!fade&&!held){sprite.texture=textures[face]||textures.neutral;sprite.visible=true;sprite.alpha=1;videoSprite.visible=false}
      if(fade){
        const f=Math.min(1,(t-fade.start)/fade.duration)
        if(fade.kind==='in'){sprite.visible=false;outgoing.alpha=1-f;videoSprite.alpha=f;if(f===1){outgoing.visible=false;sprite.visible=false}}
        else{sprite.texture=textures[face]||textures.neutral;sprite.alpha=f;videoSprite.alpha=1-f;if(f===1){videoSprite.visible=false;resetTransform()}}
        if(f===1)fade=null
      }
      if(!active&&!fade&&!held){
        sprite.position.set(W/2,H);sprite.scale.set(1);sprite.rotation=0
        if(dragging&&!reduced.matches){sprite.rotation=dragAngle;sprite.y=H-5}
        else if(override&&!reduced.matches){
          const elapsed=(t-actionStart)/1000,e=Math.sin(Math.min(1,elapsed/2.6)*Math.PI)**2
          if(override==='success')sprite.y=H-Math.max(0,Math.sin(elapsed*5))*8*e
          else if(['nod','greet','listen'].includes(override))sprite.rotation=Math.sin(elapsed*5)*.012*e
          else if(override==='music'&&current.music?.playing)sprite.rotation=Math.sin(elapsed*5)*.012*e
        }
      }
      if(t>=nextReadingAt&&t-lastInput>=45000&&(!active||active.source==='base')&&!pendingName&&!fade&&!override&&!busy()&&!blocked('ambient')&&!roamDir&&!reduced.matches){nextReadingAt=t+150000;startReading('ambient')}
      if(t>=nextAmbient&&(!active||active.source==='base')&&!pendingName&&!fade&&!override&&!busy()&&!blocked('ambient')&&!roamDir&&!reduced.matches){
        const idle=t-lastInput
        if(idle>=45000){const choices=['yawn','stretch','scarf','bubble'];const name=choices[ambientIndex++%choices.length];lastAmbient=name;playClip(name,{source:'ambient'})}
        nextAmbient=t+75000+Math.random()*30000
      }
      if(!active&&!pendingName&&!reading&&!override&&!busy()&&!blocked('base')&&!reduced.matches&&meta.clips.idle)playClip('idle',{loop:true,source:'base'})
      window.__SONGM_ACT={act:active?.name||'rest',idle:Math.floor((t-lastInput)/1000),stable:!active&&!override&&!dragging}
    })
    const ownActions=meta.demo?[['nod','点头（示例）'],['greet','招呼（示例）']]:[['reading','坐着看书'],['stand','合书起身'],['scarf','整理围巾与摆尾'],['nod','轻轻点头'],['greet','打招呼'],['think','认真想想'],['success','完成啦'],['listen','侧耳听'],['fail','遇到困难'],['music','跟着节拍'],['sleep','困倦表情'],['stretch','伸懒腰'],['yawn','打哈欠'],['bubble','吐泡泡'],['spin','转个圈']]
    const api={app,model,
      async perform(name){const token=++intent;if(name==='reading')return startReading();if(name==='stand')return stopReading(true);if(reading)await stopReading(true);if(token!==intent||blocked('manual')||busy())return false;const key=({splash:'bubble',selfie:'yawn',aidale:'nod',stretch:'stretch'})[name]||name;if(meta.clips[key])return playClip(key);clearPlayback('manual');action=key;actionStart=now();actionUntil=actionStart+2600;return true},
      actions(){return ownActions.map(([key,label])=>({key,label,ms:meta.clips[key]?.duration*1000||2600}))},
      cancelAction(){intent++;resetReading();action='';actionUntil=0;roamDir=0;roamEpoch++;clearPlayback('task-event')},
      drag(on,dx){dragging=!!on;dragAngle=Math.max(-.035,Math.min(.035,-(dx||0)/2400));input();if(on){intent++;resetReading();roamDir=0;roamEpoch++;clearPlayback('drag')}},
      setRoam,playClip,suspend,resume,startReading,stopReading,
      snapshot(){return {renderer:'songm-v5',master:'narrow-tail-v2',masterSize:[W,H],reading,roamBlocked:reading||active?.name==='read-out'||(active&&!['roam','base'].includes(active.source))||reduced.matches,face,mood:current.mood,status:current.status||'idle',music:!!current.music?.playing,dragging,action,clip:active?.name||null,clipSource:active?.source||null,held,outgoing:outgoing.visible,staticVisible:sprite.visible,pending:pendingName,roamDir,paused,stable:!active&&!action&&!dragging,lastError,reducedMotion:reduced.matches,history:history.slice(),transform:{x:sprite.x,y:sprite.y,sx:sprite.scale.x,sy:sprite.scale.y,rotation:sprite.rotation}}}
    }
    window.__songmPlay=n=>api.perform(n);window.__songmRoam=setRoam
    window.__songmClipsReady=()=>Object.entries(meta.clips).map(([k,d])=>({k,rs:videos.get(k)?.video.readyState||0,dur:d.duration}))
    window.__songmTest=new URLSearchParams(location.search).has('preview')?{blink:()=>{nextBlink=now()},ambient:()=>{lastInput=now()-160000;nextAmbient=now()},reading:()=>{lastInput=now()-46000;nextReadingAt=now()},finishReading:()=>stopReading(true)}:undefined
    Promise.allSettled(Object.keys(meta.clips).filter(n=>['idle','yawn','stretch','run-in','run-loop','run-out','read-in','read-loop','read-out'].includes(n)).map(loadVideo))
    restoreStatic();return api
  }
})()
