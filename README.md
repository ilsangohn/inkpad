# inkpad — 강의 노트

iPad Safari에서 쓰는 강의용 PDF 필기 웹앱(PWA)입니다.

- PDF 열기, Apple Pencil 필기(펜, 형광펜, 지우개, 색과 굵기)
- 빈 페이지 추가와 페이지 삭제, 실행 취소와 다시 실행
- 올가미로 필기 선택: 옮기기, 복사, 잘라내기, 삭제. 복사한 필기는 올가미로 빈 곳을 한 번 눌러 붙여넣기(다른 페이지·다른 문서도 가능)
- 필기를 합친 PDF로 내보내기: iPad 공유 시트로 파일 앱, Drive, 메일 등에 업로드
- 필기는 iPad 브라우저 저장소(IndexedDB)에 자동 저장됩니다. 서버로는 아무것도 보내지 않습니다.

## 조작

- Pencil: 필기. 손가락 한 개: 스크롤. 손가락 두 개: 확대·축소.
- 더보기(⋯) 메뉴: 폭에 맞추기, 확대·축소, 손가락으로 필기, 페이지 삭제, 이름 바꾸기.
- 키보드: ⌘Z 실행 취소, ⇧⌘Z 다시 실행, ⌘C/⌘X/⌘V 복사·잘라내기·붙여넣기, P/H/E/L 도구 전환.

## 개발

```bash
node serve.js 8790
```

브라우저에서 http://localhost:8790 을 엽니다. `test/sample.pdf`는 회전 페이지가 들어 있는 시험용 PDF입니다.

외부 라이브러리는 `vendor/`에 들어 있습니다(pdf.js 4.10.38 legacy build, pdf-lib 1.17.1). 업데이트할 때는 `npm install` 후 `node_modules`에서 다시 복사합니다.

## iPad에 설치

https://ilsangohn.github.io/inkpad/ 를 iPad Safari에서 열고, 공유 버튼 → "홈 화면에 추가"를 누릅니다. 오프라인 사용과 공유 시트는 HTTPS에서만 동작합니다.
