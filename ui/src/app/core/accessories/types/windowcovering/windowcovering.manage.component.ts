import { Component, OnInit, Input } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { ServiceTypeX } from '../../accessories.interfaces';

import { Subject } from 'rxjs/Subject';
import 'rxjs/add/operator/debounceTime';
import 'rxjs/add/operator/distinctUntilChanged';

@Component({
  selector: 'app-windowcovering-manage',
  templateUrl: './windowcovering.manage.component.html',
  styleUrls: ['./windowcovering.component.scss'],
})
export class WindowcoveringManageComponent implements OnInit {
  @Input() public service: ServiceTypeX;
  public targetMode: any;
  public targetPosition: any;
  public targetPositionChanged: Subject<string> = new Subject<string>();

  constructor(
    public activeModal: NgbActiveModal,
  ) {
    this.targetPositionChanged
      .debounceTime(300)
      .distinctUntilChanged()
      .subscribe((value) => {
        if (this.service.getCharacteristic('CurrentPosition').value < this.targetPosition.value) {
          this.service.values.PositionState = 1;
        } else if (this.service.getCharacteristic('CurrentPosition').value > this.targetPosition.value) {
          this.service.values.PositionState = 0;
        }
        this.service.getCharacteristic('TargetPosition').setValue(this.targetPosition.value);
      });
  }

  ngOnInit() {
    this.targetMode = this.service.values.On;
    this.loadTargetPosition();
  }

  loadTargetPosition() {
    const TargetPosition = this.service.getCharacteristic('TargetPosition');

    if (TargetPosition) {
      this.targetPosition = {
        value: TargetPosition.value,
        min: TargetPosition.minValue,
        max: TargetPosition.maxValue,
        step: TargetPosition.minStep,
      };
    }
  }

  onTargetPositionChange() {
    this.targetPositionChanged.next(this.targetPosition.value);
  }

}
